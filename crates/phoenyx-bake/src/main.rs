//! phoenyx-bake: genera modelos procedurales de muy alta resolucion y su cadena de LOD.
//! Salida en web/assets: verts.bin (12 B/vertice: pos snorm16x4 + normal octaedrica snorm16x2),
//! idx.bin (u32 locales a cada bloque) y meta.json.
//! Uso: phoenyx-bake [--sub 7] [--models 8] [--out web/assets]
use meshopt::{SimplifyOptions, VertexDataAdapter, optimize_vertex_cache, simplify, simplify_scale, simplify_sloppy};
use std::{collections::HashMap, fs, io::Write};

const LODS: usize = 10;

type V3 = [f32; 3];
fn len(a: V3) -> f32 { (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt() }
fn scale(a: V3, s: f32) -> V3 { [a[0] * s, a[1] * s, a[2] * s] }
fn norm(a: V3) -> V3 { scale(a, 1.0 / len(a).max(1e-20)) }
fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn hash(x: i32, y: i32, z: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(374761393)
        ^ (y as u32).wrapping_mul(668265263)
        ^ (z as u32).wrapping_mul(2147483647)
        ^ seed.wrapping_mul(1274126177);
    h = (h ^ (h >> 13)).wrapping_mul(1274126177);
    ((h ^ (h >> 16)) & 0xffffff) as f32 / 16777215.0
}

fn noise(p: V3, seed: u32) -> f32 {
    let (ix, iy, iz) = (p[0].floor(), p[1].floor(), p[2].floor());
    let (fx, fy, fz) = (p[0] - ix, p[1] - iy, p[2] - iz);
    let s = |t: f32| t * t * (3.0 - 2.0 * t);
    let (u, v, w) = (s(fx), s(fy), s(fz));
    let (ix, iy, iz) = (ix as i32, iy as i32, iz as i32);
    let h = |dx, dy, dz| hash(ix + dx, iy + dy, iz + dz, seed);
    let l = |a: f32, b: f32, t: f32| a + (b - a) * t;
    l(
        l(l(h(0, 0, 0), h(1, 0, 0), u), l(h(0, 1, 0), h(1, 1, 0), u), v),
        l(l(h(0, 0, 1), h(1, 0, 1), u), l(h(0, 1, 1), h(1, 1, 1), u), v),
        w,
    )
}

fn fbm(p: V3, oct: u32, seed: u32) -> f32 {
    let (mut a, mut f, mut s, mut n) = (0.5, 1.0, 0.0, 0.0);
    for o in 0..oct {
        s += a * noise(scale(p, f), seed + o);
        n += a;
        a *= 0.5;
        f *= 2.0;
    }
    s / n
}

fn ridged(p: V3, oct: u32, seed: u32) -> f32 {
    let (mut a, mut f, mut s, mut n) = (0.5, 1.0, 0.0, 0.0);
    for o in 0..oct {
        s += a * (1.0 - (2.0 * noise(scale(p, f), seed + o) - 1.0).abs());
        n += a;
        a *= 0.5;
        f *= 2.0;
    }
    s / n
}

/// Radio de la superficie en la direccion d para cada familia de modelos.
fn radius(kind: usize, d: V3, seed: u32) -> f32 {
    let q = |s: f32| scale(d, s);
    match kind % 8 {
        0 => 1.0 + 0.6 * (fbm(q(1.7), 8, seed) - 0.5),
        1 => 0.8 + 0.45 * ridged(q(2.0), 8, seed),
        2 => 1.0 + 0.4 * (fbm(q(1.2), 6, seed) - 0.5) + 0.05 * (30.0 * d[1] + 8.0 * fbm(q(3.0), 3, seed)).sin(),
        3 => 1.0 + 0.6 * ((fbm(q(3.5), 5, seed) - 0.45).max(0.0) * 3.0).powf(1.5),
        4 => 1.0 + 0.25 * (9.0 * d[0]).sin() * (9.0 * d[1]).sin() * (9.0 * d[2]).sin() + 0.1 * fbm(q(8.0), 6, seed),
        5 => {
            let a = 3.0 * d[1];
            let r = [d[0] * a.cos() - d[2] * a.sin(), d[1], d[0] * a.sin() + d[2] * a.cos()];
            1.0 + 0.6 * (fbm(scale(r, 2.5), 7, seed) - 0.5)
        }
        6 => 0.85 + 0.25 * ridged(q(5.0), 8, seed),
        _ => 1.0 + 0.4 * (fbm(q(1.3), 5, seed) - 0.5) + 0.06 * (40.0 * d[1] + 5.0 * fbm(q(2.0), 4, seed)).sin(),
    }
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Radio de una estatua de revolucion en (angulo, altura y en [-1, 0.88]).
/// 8 variantes: plinto, cuerpo con pliegues, hombros, brazos, cabeza y remate.
fn statue_r(v: usize, th: f32, y: f32) -> f32 {
    let (c, s) = (th.cos(), th.sin());
    let vf = v as f32;
    // Plinto: superelipse (cuadrado en unas variantes, redondo en otras).
    let pw = if v % 2 == 0 { 4.0 } else { 2.0 };
    let sq = 1.0 / (c.abs().powf(pw) + s.abs().powf(pw)).powf(1.0 / pw);
    let ped = if y < -0.62 { 0.30 * sq.min(1.45) } else { 0.0 };
    // Cuerpo con pliegues verticales de tunica.
    let t = ((y + 0.62) / 1.07).clamp(0.0, 1.0);
    let folds = 0.035 * (th * (5.0 + vf) + 6.0 * t).sin() + 0.018 * (th * (13.0 + vf * 2.0) - 9.0 * t).sin();
    let body = if (-0.62..=0.45).contains(&y) { (0.25 - 0.06 * t) * (1.0 + folds * 2.2) } else { 0.0 };
    // Hombros y brazos (lobulos laterales).
    let sh = (0.20 + 0.02 * vf) * (-((y - 0.38) / 0.085).powi(2)).exp();
    let arm_w = 0.07 + 0.01 * (v % 3) as f32;
    let arms = arm_w * c.abs().powi(6) * smoothstep(-0.25, 0.1, y) * (1.0 - smoothstep(0.3, 0.42, y));
    let neck = if (0.4..0.56).contains(&y) { 0.075 } else { 0.0 };
    let hy = (y - 0.68) / 0.2;
    let head = 0.165 * (1.0 - hy * hy).max(0.0).sqrt();
    // Remate segun variante: corona, cresta de casco, rizos o liso.
    let crown = match v % 4 {
        0 => 0.05 * (th * 6.0).sin().max(0.0) * smoothstep(0.7, 0.8, y),
        1 => 0.06 * c.max(0.0).powi(3) * smoothstep(0.72, 0.84, y),
        2 => 0.03 * (th * 9.0 + y * 40.0).sin() * smoothstep(0.62, 0.76, y),
        _ => 0.0,
    };
    ped.max(body).max(sh + body * 0.6).max(neck).max(head + crown) + arms * if y < 0.45 { 1.0 } else { 0.0 }
}

/// Malla de revolucion: (theta, y, 0) por vertice y caras de la rejilla seg x rings.
fn lathe(seg: usize, rings: usize) -> (Vec<V3>, Vec<[u32; 3]>) {
    let mut v = Vec::with_capacity(seg * rings);
    for j in 0..rings {
        let y = -1.0 + 1.879 * j as f32 / (rings - 1) as f32;
        for i in 0..seg {
            v.push([std::f32::consts::TAU * i as f32 / seg as f32, y, 0.0]);
        }
    }
    let mut f = Vec::with_capacity(2 * seg * (rings - 1));
    for j in 0..rings - 1 {
        for i in 0..seg {
            let i1 = (i + 1) % seg;
            let (a, b) = ((j * seg + i) as u32, (j * seg + i1) as u32);
            let (c, d) = (((j + 1) * seg + i) as u32, ((j + 1) * seg + i1) as u32);
            f.push([a, c, b]);
            f.push([b, c, d]);
        }
    }
    (v, f)
}

/// Icosfera subdividida `sub` veces: (vertices unitarios, caras).
fn icosphere(sub: u32) -> (Vec<V3>, Vec<[u32; 3]>) {
    let t = (1.0 + 5f32.sqrt()) / 2.0;
    let mut v: Vec<V3> = [
        [-1., t, 0.], [1., t, 0.], [-1., -t, 0.], [1., -t, 0.],
        [0., -1., t], [0., 1., t], [0., -1., -t], [0., 1., -t],
        [t, 0., -1.], [t, 0., 1.], [-t, 0., -1.], [-t, 0., 1.],
    ]
    .iter()
    .map(|&p| norm(p))
    .collect();
    let mut f: Vec<[u32; 3]> = vec![
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for _ in 0..sub {
        let mut cache: HashMap<(u32, u32), u32> = HashMap::new();
        let mut mid = |a: u32, b: u32, v: &mut Vec<V3>| -> u32 {
            *cache.entry((a.min(b), a.max(b))).or_insert_with(|| {
                let (p, q) = (v[a as usize], v[b as usize]);
                v.push(norm([(p[0] + q[0]) * 0.5, (p[1] + q[1]) * 0.5, (p[2] + q[2]) * 0.5]));
                v.len() as u32 - 1
            })
        };
        let mut nf = Vec::with_capacity(f.len() * 4);
        for [a, b, c] in f {
            let (ab, bc, ca) = (mid(a, b, &mut v), mid(b, c, &mut v), mid(c, a, &mut v));
            nf.extend([[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]);
        }
        f = nf;
    }
    (v, f)
}

fn snorm(x: f32) -> i16 { (x.clamp(-1.0, 1.0) * 32767.0).round() as i16 }

fn oct(n: V3) -> [i16; 2] {
    let s = n[0].abs() + n[1].abs() + n[2].abs();
    let (mut x, mut y) = (n[0] / s, n[1] / s);
    if n[2] < 0.0 {
        let (ox, oy) = (x, y);
        x = (1.0 - oy.abs()) * if ox >= 0.0 { 1.0 } else { -1.0 };
        y = (1.0 - ox.abs()) * if oy >= 0.0 { 1.0 } else { -1.0 };
    }
    [snorm(x), snorm(y)]
}

struct Spec {
    statue: bool,
    sub: u32,
    variant: usize,
}

/// Malla lista para hornear: posiciones en esfera unidad, normales, tangentes (w = signo), UV y
/// texturas opcionales (base, normal, ORM).
struct Mesh {
    pos: Vec<V3>,
    nrm: Vec<V3>,
    tan: Vec<[f32; 4]>,
    uv: Vec<[f32; 2]>,
    idx: Vec<u32>,
    maps: Option<[image::RgbaImage; 3]>,
    base_off: f32,
    height: f32,
}

fn extents_y(pos: &[V3]) -> (f32, f32) {
    let lo = pos.iter().map(|p| p[1]).fold(f32::MAX, f32::min);
    let hi = pos.iter().map(|p| p[1]).fold(f32::MIN, f32::max);
    (-lo, hi - lo)
}

fn proc_mesh(spec: &Spec, dirs: &[V3], faces: &[[u32; 3]]) -> Mesh {
    let seed = 17 + spec.variant as u32 * 101;
    let mut pos: Vec<V3> = if spec.statue {
        dirs.iter()
            .map(|&d| {
                // Relieve tallado de alta frecuencia sobre el perfil.
                let base = [d[0].cos(), d[1], d[0].sin()];
                let det = 0.012 * (fbm(scale(base, 14.0), 6, seed) - 0.5) * smoothstep(-0.62, -0.55, d[1]);
                let r = (statue_r(spec.variant, d[0], d[1]) + det).max(0.0005);
                [r * d[0].cos(), d[1], r * d[0].sin()]
            })
            .collect()
    } else {
        dirs.iter().map(|&d| scale(d, radius(spec.variant, d, seed))).collect()
    };
    let mx = pos.iter().map(|&p| len(p)).fold(0.0, f32::max);
    for p in &mut pos { *p = scale(*p, 1.0 / mx); }
    let mut nrm = vec![[0f32; 3]; pos.len()];
    for &[i, j, k] in faces {
        let n = cross(sub(pos[j as usize], pos[i as usize]), sub(pos[k as usize], pos[i as usize]));
        for &x in &[i, j, k] {
            for c in 0..3 { nrm[x as usize][c] += n[c]; }
        }
    }
    let nrm: Vec<V3> = nrm.iter().map(|&n| norm(n)).collect();
    let (base_off, height) = extents_y(&pos);
    let n = pos.len();
    Mesh {
        pos,
        nrm,
        tan: vec![[1.0, 0.0, 0.0, 1.0]; n],
        uv: vec![[0.0; 2]; n],
        idx: faces.iter().flatten().copied().collect(),
        maps: None,
        base_off,
        height,
    }
}

fn to_rgba(d: &gltf::image::Data) -> image::RgbaImage {
    use gltf::image::Format as F;
    let mut out = Vec::with_capacity((d.width * d.height * 4) as usize);
    match d.format {
        F::R8G8B8A8 => out.extend_from_slice(&d.pixels),
        F::R8G8B8 => for p in d.pixels.chunks_exact(3) { out.extend([p[0], p[1], p[2], 255]); },
        F::R8G8 => for p in d.pixels.chunks_exact(2) { out.extend([p[0], p[1], 0, 255]); },
        F::R8 => for &p in &d.pixels { out.extend([p, p, p, 255]); },
        f => panic!("formato de imagen no soportado: {f:?}"),
    }
    image::RgbaImage::from_raw(d.width, d.height, out).unwrap()
}

type M4 = [[f32; 4]; 4];

fn mul4(a: &M4, b: &M4) -> M4 {
    let mut o = [[0f32; 4]; 4];
    for c in 0..4 {
        for r in 0..4 {
            o[c][r] = (0..4).map(|k| a[k][r] * b[c][k]).sum();
        }
    }
    o
}

fn world_of(node: gltf::Node, parent: &M4, mesh: usize) -> Option<M4> {
    let m = mul4(parent, &node.transform().matrix());
    if node.mesh().map(|x| x.index()) == Some(mesh) {
        return Some(m);
    }
    node.children().find_map(|c| world_of(c, &m, mesh))
}

fn load_glb(path: &str) -> Mesh {
    println!("leyendo {path}");
    let (doc, bufs, imgs) = gltf::import(path).unwrap();
    let mesh = doc.meshes().next().unwrap();
    let prim = mesh.primitives().next().unwrap();
    let rd = prim.reader(|b| Some(&bufs[b.index()]));
    let mut pos: Vec<V3> = rd.read_positions().unwrap().collect();
    let n = pos.len();
    let mut nrm: Vec<V3> = rd.read_normals().map(|i| i.collect()).unwrap_or_else(|| vec![[0., 1., 0.]; n]);
    let mut tan: Vec<[f32; 4]> = rd.read_tangents().map(|i| i.collect()).unwrap_or_else(|| vec![[1., 0., 0., 1.]; n]);
    let uv: Vec<[f32; 2]> = rd.read_tex_coords(0).map(|i| i.into_f32().collect()).unwrap_or_else(|| vec![[0.; 2]; n]);
    let idx: Vec<u32> = rd.read_indices().unwrap().into_u32().collect();

    // Transformacion del nodo que usa la malla.
    let ident: M4 = [[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1., 0.], [0., 0., 0., 1.]];
    let w = doc
        .default_scene()
        .or_else(|| doc.scenes().next())
        .and_then(|s| s.nodes().find_map(|nd| world_of(nd, &ident, mesh.index())))
        .unwrap_or(ident);
    let rot = |v: V3| norm([
        w[0][0] * v[0] + w[1][0] * v[1] + w[2][0] * v[2],
        w[0][1] * v[0] + w[1][1] * v[1] + w[2][1] * v[2],
        w[0][2] * v[0] + w[1][2] * v[1] + w[2][2] * v[2],
    ]);
    for p in &mut pos {
        let q = *p;
        *p = [
            w[0][0] * q[0] + w[1][0] * q[1] + w[2][0] * q[2] + w[3][0],
            w[0][1] * q[0] + w[1][1] * q[1] + w[2][1] * q[2] + w[3][1],
            w[0][2] * q[0] + w[1][2] * q[1] + w[2][2] * q[2] + w[3][2],
        ];
    }
    for v in &mut nrm { *v = rot(*v); }
    for t in &mut tan {
        let r = rot([t[0], t[1], t[2]]);
        *t = [r[0], r[1], r[2], t[3]];
    }

    // Centrado en la caja y escala a esfera unidad.
    let lo = (0..3).map(|c| pos.iter().map(|p| p[c]).fold(f32::MAX, f32::min)).collect::<Vec<_>>();
    let hi = (0..3).map(|c| pos.iter().map(|p| p[c]).fold(f32::MIN, f32::max)).collect::<Vec<_>>();
    let ctr = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0];
    let r = pos.iter().map(|&p| len(sub(p, ctr))).fold(0.0, f32::max);
    for p in &mut pos { *p = scale(sub(*p, ctr), 1.0 / r); }
    let (base_off, height) = extents_y(&pos);

    // Texturas: base, normal y ORM (oclusion/rugosidad/metal).
    let mat = prim.material();
    let pbr = mat.pbr_metallic_roughness();
    let img = |t: Option<usize>, d: [u8; 4]| match t {
        Some(i) => to_rgba(&imgs[i]),
        None => image::RgbaImage::from_pixel(1, 1, image::Rgba(d)),
    };
    let src = |t: Option<gltf::texture::Info>| t.map(|t| t.texture().source().index());
    let base = img(src(pbr.base_color_texture()), [255, 255, 255, 255]);
    let normal = img(mat.normal_texture().map(|t| t.texture().source().index()), [128, 128, 255, 255]);
    let orm = img(src(pbr.metallic_roughness_texture()), [255, 200, 0, 255]);
    println!(
        "  {} vertices, {} triangulos, texturas {}x{} / {}x{} / {}x{}",
        n, idx.len() / 3, base.width(), base.height(), normal.width(), normal.height(), orm.width(), orm.height()
    );
    Mesh { pos, nrm, tan, uv, idx, maps: Some([base, normal, orm]), base_off, height }
}

/// Texel size x size y su cadena de mips, concatenados (RGBA8).
fn pack_mips(img: &image::RgbaImage, size: u32) -> Vec<u8> {
    use image::imageops::{FilterType, resize};
    let mut cur = resize(img, size, size, FilterType::Lanczos3);
    let mut out = cur.as_raw().clone();
    let mut s = size;
    while s > 1 {
        s /= 2;
        cur = resize(&cur, s, s, FilterType::Triangle);
        out.extend_from_slice(cur.as_raw());
    }
    out
}

mod skin;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let arg = |k: &str, d: &str| {
        a.iter().position(|x| x == k).and_then(|i| a.get(i + 1)).cloned().unwrap_or(d.into())
    };
    let sub_n: u32 = arg("--sub", "7").parse().unwrap();
    let models: usize = arg("--models", "8").parse().unwrap();
    let out = arg("--out", "web/assets");
    let kind = arg("--kind", "rock");
    let tex_size: u32 = arg("--tex", "2048").parse().unwrap();
    let glbs = arg("--glb", "");
    let ground_dir = arg("--ground", "");
    let gsize: u32 = arg("--gsize", "2048").parse().unwrap();
    if kind == "skin" {
        skin::run(&glbs, &out, arg("--fps", "30").parse().unwrap(), tex_size);
        return;
    }
    fs::create_dir_all(&out).unwrap();

    // Lista de modelos a generar (GLB reales o procedurales).
    let specs: Vec<Spec> = match kind.as_str() {
        "demo" => {
            let mut v = vec![Spec { statue: true, sub: 8, variant: 2 }];
            for k in [0, 1, 6, 7] {
                v.push(Spec { statue: false, sub: 7, variant: k });
            }
            v
        }
        "statue" => (0..models).map(|m| Spec { statue: true, sub: sub_n, variant: m }).collect(),
        "glb" => vec![],
        _ => (0..models).map(|m| Spec { statue: false, sub: sub_n, variant: m }).collect(),
    };
    let glb_paths: Vec<&str> = glbs.split(',').filter(|s| !s.is_empty()).collect();

    let mut cache: Vec<((bool, u32), (Vec<V3>, Vec<[u32; 3]>))> = vec![];
    let mut meshes: Vec<Mesh> = vec![];
    for spec in &specs {
        let key = (spec.statue, spec.sub);
        if !cache.iter().any(|(k, _)| *k == key) {
            let base = if spec.statue {
                let k = 2f32.powi(spec.sub as i32 - 7);
                lathe((640.0 * k) as usize, (256.0 * k) as usize)
            } else {
                icosphere(spec.sub)
            };
            cache.push((key, base));
        }
        let (dirs, faces) = &cache.iter().find(|(k, _)| *k == key).unwrap().1;
        meshes.push(proc_mesh(spec, dirs, faces));
    }
    for p in &glb_paths { meshes.push(load_glb(p)); }

    let (mut vb, mut ib): (Vec<u8>, Vec<u8>) = (vec![], vec![]);
    let (mut vcount, mut icount) = (0u32, 0u32);
    let mut draws = String::new();
    let mut info: Vec<String> = vec![];
    let mut tris0s: Vec<usize> = vec![];
    let mut total_tris = 0usize;
    let textured = meshes.iter().all(|m| m.maps.is_some());
    let (mut t_base, mut t_norm, mut t_orm): (Vec<u8>, Vec<u8>, Vec<u8>) = (vec![], vec![], vec![]);

    for (m, mesh) in meshes.iter().enumerate() {
        let tris0 = mesh.idx.len() / 3;
        tris0s.push(tris0);
        println!("modelo {m}: {} vertices, {tris0} triangulos", mesh.pos.len());
        let bytes: Vec<u8> = mesh.pos.iter().flat_map(|p| p.iter().flat_map(|c| c.to_le_bytes())).collect();
        let adapter = VertexDataAdapter::new(&bytes, 12, 0).unwrap();
        let mut idx = optimize_vertex_cache(&mesh.idx, mesh.pos.len());
        let mut err = 0f32;
        // info por modelo (12 floats): radio, err0..err5, desplazamiento a la base, alto, 3 libres
        let mut row = vec![1.0f32, 0.0];
        for l in 0..LODS {
            let cur = if l == 0 {
                idx.clone()
            } else {
                let target = (tris0 / 4usize.pow(l as u32)).max(12) * 3;
                let mut e = 0f32;
                let mut r = simplify(&idx, &adapter, target, 1.0e9, SimplifyOptions::ErrorAbsolute, Some(&mut e));
                // Si la topologia (costuras de UV) impide llegar al objetivo, simplificacion "sloppy".
                if r.len() > target * 3 / 2 {
                    let mut e2 = 0f32;
                    r = simplify_sloppy(&idx, &adapter, target, 1.0e9, Some(&mut e2));
                    e = e2 * simplify_scale(&adapter);
                }
                err += e;
                idx = r.clone();
                row.push(err);
                r
            };
            let cur = optimize_vertex_cache(&cur, mesh.pos.len());
            // Bloque de vertices compacto, en orden de primer uso (20 B por vertice).
            let mut remap = vec![u32::MAX; mesh.pos.len()];
            let mut used = 0u32;
            let mut local = Vec::with_capacity(cur.len());
            for &i in &cur {
                let i = i as usize;
                if remap[i] == u32::MAX {
                    remap[i] = used;
                    used += 1;
                    for c in mesh.pos[i] { vb.extend(snorm(c).to_le_bytes()); }
                    vb.extend(snorm(if mesh.tan[i][3] < 0.0 { -1.0 } else { 1.0 }).to_le_bytes());
                    for c in oct(mesh.nrm[i]) { vb.extend(c.to_le_bytes()); }
                    for c in oct([mesh.tan[i][0], mesh.tan[i][1], mesh.tan[i][2]]) { vb.extend(c.to_le_bytes()); }
                    for c in mesh.uv[i] { vb.extend(((c.clamp(0.0, 1.0) * 65535.0).round() as u16).to_le_bytes()); }
                }
                local.push(remap[i]);
            }
            for i in &local { ib.extend(i.to_le_bytes()); }
            draws += &format!("[{},{},{}],", local.len(), icount, vcount);
            icount += local.len() as u32;
            vcount += used;
            total_tris += local.len() / 3;
            println!("  lod {l}: {} tris, {} verts, error {:.5}", local.len() / 3, used, err);
        }
        while row.len() < 13 { row.push(0.0); }
        row.push(mesh.base_off);
        row.push(mesh.height);
        row.push(0.0);
        info.push(row.iter().map(|x| format!("{x:.6}")).collect::<Vec<_>>().join(","));
        if textured {
            let maps = mesh.maps.as_ref().unwrap();
            t_base.extend(pack_mips(&maps[0], tex_size));
            t_norm.extend(pack_mips(&maps[1], tex_size));
            t_orm.extend(pack_mips(&maps[2], tex_size));
        }
    }
    let mips = 32 - tex_size.leading_zeros();
    let tex_meta = if textured {
        format!(",\"tex\":{{\"size\":{tex_size},\"mips\":{mips},\"layers\":{}}}", meshes.len())
    } else {
        String::new()
    };
    // Suelo: material tileable (color sRGB; normal con la rugosidad en alfa).
    let mut ground_meta = String::new();
    if !ground_dir.is_empty() {
        let find = |suffix: &str| -> String {
            fs::read_dir(&ground_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.path().to_string_lossy().to_string())
                .find(|p| p.to_lowercase().ends_with(&suffix.to_lowercase()))
                .unwrap_or_else(|| panic!("falta *{suffix} en {ground_dir}"))
        };
        let base = image::open(find("_BaseColor.jpg")).unwrap().to_rgba8();
        let mut normal = image::open(find("_Normal.jpg")).unwrap().to_rgba8();
        let rough = image::open(find("_Roughness.jpg")).unwrap().to_rgba8();
        let rough = image::imageops::resize(&rough, normal.width(), normal.height(), image::imageops::FilterType::Triangle);
        for (n, r) in normal.pixels_mut().zip(rough.pixels()) { n.0[3] = r.0[0]; }
        fs::write(format!("{out}/ground_base.bin"), pack_mips(&base, gsize)).unwrap();
        fs::write(format!("{out}/ground_normal.bin"), pack_mips(&normal, gsize)).unwrap();
        ground_meta = format!(",\"ground\":{{\"size\":{gsize},\"mips\":{}}}", 32 - gsize.leading_zeros());
        println!("suelo: {}x{} -> {gsize}", base.width(), base.height());
    }
    let meta = format!(
        "{{\"models\":{},\"lods\":{LODS},\"stride\":16,\"tris0\":[{}],\"draws\":[{}],\"info\":[{}]{tex_meta}{ground_meta}}}",
        meshes.len(),
        tris0s.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","),
        draws.trim_end_matches(','),
        info.join(",")
    );
    fs::File::create(format!("{out}/verts.bin")).unwrap().write_all(&vb).unwrap();
    fs::File::create(format!("{out}/idx.bin")).unwrap().write_all(&ib).unwrap();
    if textured {
        fs::write(format!("{out}/tex_base.bin"), &t_base).unwrap();
        fs::write(format!("{out}/tex_normal.bin"), &t_norm).unwrap();
        fs::write(format!("{out}/tex_orm.bin"), &t_orm).unwrap();
    }
    fs::write(format!("{out}/meta.json"), meta).unwrap();
    println!(
        "ok: {} MB vertices, {} MB indices, {} MB texturas, {} tris en total (todos los LOD)",
        vb.len() / 1_000_000,
        ib.len() / 1_000_000,
        (t_base.len() + t_norm.len() + t_orm.len()) / 1_000_000,
        total_tris
    );
}
