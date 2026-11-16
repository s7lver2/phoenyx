//! phoenix-bake: genera modelos procedurales de muy alta resolucion y su cadena de LOD.
//! Salida en web/assets: verts.bin (12 B/vertice: pos snorm16x4 + normal octaedrica snorm16x2),
//! idx.bin (u32 locales a cada bloque) y meta.json.
//! Uso: phoenix-bake [--sub 7] [--models 8] [--out web/assets]
use meshopt::{SimplifyOptions, VertexDataAdapter, optimize_vertex_cache, simplify};
use std::{collections::HashMap, fs, io::Write};

const LODS: usize = 6;

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

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let arg = |k: &str, d: &str| {
        a.iter().position(|x| x == k).and_then(|i| a.get(i + 1)).cloned().unwrap_or(d.into())
    };
    let sub_n: u32 = arg("--sub", "7").parse().unwrap();
    let models: usize = arg("--models", "8").parse().unwrap();
    let out = arg("--out", "web/assets");
    fs::create_dir_all(&out).unwrap();

    let (dirs, faces) = icosphere(sub_n);
    let tris0 = faces.len();
    println!("base: {} vertices, {} triangulos por modelo", dirs.len(), tris0);

    let (mut vb, mut ib): (Vec<u8>, Vec<u8>) = (vec![], vec![]);
    let (mut vcount, mut icount) = (0u32, 0u32);
    let mut draws = String::new();
    let mut info: Vec<String> = vec![];
    let mut total_tris = 0usize;

    for m in 0..models {
        // Desplazamiento + normalizacion para que el radio maximo sea 1.
        let seed = 17 + m as u32 * 101;
        let mut pos: Vec<V3> = dirs.iter().map(|&d| scale(d, radius(m, d, seed))).collect();
        let mx = pos.iter().map(|&p| len(p)).fold(0.0, f32::max);
        for p in &mut pos { *p = scale(*p, 1.0 / mx); }
        // Normales por acumulacion de normales de cara ponderadas por area.
        let mut nrm = vec![[0f32; 3]; pos.len()];
        for &[i, j, k] in &faces {
            let n = cross(sub(pos[j as usize], pos[i as usize]), sub(pos[k as usize], pos[i as usize]));
            for &x in &[i, j, k] {
                for c in 0..3 { nrm[x as usize][c] += n[c]; }
            }
        }
        let nrm: Vec<V3> = nrm.iter().map(|&n| norm(n)).collect();

        let bytes: Vec<u8> = pos.iter().flat_map(|p| p.iter().flat_map(|c| c.to_le_bytes())).collect();
        let adapter = VertexDataAdapter::new(&bytes, 12, 0).unwrap();
        let mut idx: Vec<u32> = faces.iter().flatten().copied().collect();
        idx = optimize_vertex_cache(&idx, pos.len());
        let mut err = 0f32;
        // info por modelo: [radio, err0..err5, pad] = 8 floats
        let mut row = vec![1.0f32, 0.0];
        for l in 0..LODS {
            let cur = if l == 0 {
                idx.clone()
            } else {
                let target = (tris0 / 6usize.pow(l as u32)).max(12) * 3;
                let mut e = 0f32;
                let r = simplify(&idx, &adapter, target, 1.0e9, SimplifyOptions::ErrorAbsolute, Some(&mut e));
                err += e;
                idx = r.clone();
                row.push(err);
                r
            };
            let cur = optimize_vertex_cache(&cur, pos.len());
            // Bloque de vertices compacto, en orden de primer uso.
            let mut remap = vec![u32::MAX; pos.len()];
            let mut used = 0u32;
            let mut local = Vec::with_capacity(cur.len());
            for &i in &cur {
                if remap[i as usize] == u32::MAX {
                    remap[i as usize] = used;
                    used += 1;
                    let (p, n) = (pos[i as usize], oct(nrm[i as usize]));
                    for c in p { vb.extend(snorm(c).to_le_bytes()); }
                    vb.extend(0i16.to_le_bytes());
                    for c in n { vb.extend(c.to_le_bytes()); }
                }
                local.push(remap[i as usize]);
            }
            for i in &local { ib.extend(i.to_le_bytes()); }
            draws += &format!("[{},{},{}],", local.len(), icount, vcount);
            icount += local.len() as u32;
            vcount += used;
            total_tris += local.len() / 3;
            println!("  modelo {m} lod {l}: {} tris, {} verts, error {:.5}", local.len() / 3, used, err);
        }
        row.push(0.0);
        info.push(row.iter().map(|x| format!("{x:.6}")).collect::<Vec<_>>().join(","));
    }
    let meta = format!(
        "{{\"models\":{models},\"lods\":{LODS},\"tris0\":{tris0},\"draws\":[{}],\"info\":[{}]}}",
        draws.trim_end_matches(','),
        info.join(",")
    );
    fs::File::create(format!("{out}/verts.bin")).unwrap().write_all(&vb).unwrap();
    fs::File::create(format!("{out}/idx.bin")).unwrap().write_all(&ib).unwrap();
    fs::write(format!("{out}/meta.json"), meta).unwrap();
    println!(
        "ok: {} MB vertices, {} MB indices, {} tris en total (todos los LOD)",
        vb.len() / 1_000_000,
        ib.len() / 1_000_000,
        total_tris
    );
}
