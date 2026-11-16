//! Horneado de personajes con huesos: la animacion se muestrea a `fps` y se guarda como matrices
//! de hueso por fotograma (juntas * inversa de reposo), de modo que la GPU solo mezcla 4 huesos
//! por vertice y no hay CPU por frame. Paquete: `skin.json`, `skin_verts.bin` (40 B/vertice),
//! `skin_idx.bin`, `skin_mats.bin` (3 vec4 por hueso y fotograma) y `skin_tex.bin` (RGBA8 + mips).
use glam::{Mat4, Quat, Vec3};
use std::{collections::HashMap, fs};

/// Transformacion local de un nodo en un instante (traslacion, rotacion, escala).
#[derive(Clone, Copy)]
struct Trs(Vec3, Quat, Vec3);

fn sample_vec(times: &[f32], vals: &[Vec3], t: f32) -> Vec3 {
    if times.len() == 1 || t <= times[0] {
        return vals[0];
    }
    if t >= *times.last().unwrap() {
        return *vals.last().unwrap();
    }
    let i = times.partition_point(|&x| x <= t) - 1;
    let k = (t - times[i]) / (times[i + 1] - times[i]).max(1e-9);
    vals[i].lerp(vals[i + 1], k)
}

fn sample_quat(times: &[f32], vals: &[Quat], t: f32) -> Quat {
    if times.len() == 1 || t <= times[0] {
        return vals[0];
    }
    if t >= *times.last().unwrap() {
        return *vals.last().unwrap();
    }
    let i = times.partition_point(|&x| x <= t) - 1;
    let k = (t - times[i]) / (times[i + 1] - times[i]).max(1e-9);
    vals[i].slerp(vals[i + 1], k)
}

/// Canal de animacion ya leido: nodo, propiedad y claves.
enum Chan {
    T(Vec<f32>, Vec<Vec3>),
    R(Vec<f32>, Vec<Quat>),
    S(Vec<f32>, Vec<Vec3>),
}

pub fn run(glb: &str, out: &str, fps: f32, tex_size: u32) {
    use gltf::animation::util::ReadOutputs as RO;
    println!("leyendo {glb}");
    let (doc, bufs, imgs) = gltf::import(glb).unwrap();
    let skin = doc.skins().next().expect("el GLB no tiene skin");
    let joints: Vec<usize> = skin.joints().map(|j| j.index()).collect();
    let nb = joints.len();
    let ibm: Vec<Mat4> = skin
        .reader(|b| Some(&bufs[b.index()]))
        .read_inverse_bind_matrices()
        .map(|i| i.map(|m| Mat4::from_cols_array_2d(&m)).collect())
        .unwrap_or_else(|| vec![Mat4::IDENTITY; nb]);

    // Malla enlazada a la skin.
    let node = doc.nodes().find(|n| n.skin().is_some() && n.mesh().is_some()).expect("sin malla con skin");
    let prim = node.mesh().unwrap().primitives().next().unwrap();
    let rd = prim.reader(|b| Some(&bufs[b.index()]));
    let pos: Vec<[f32; 3]> = rd.read_positions().unwrap().collect();
    let n = pos.len();
    let nrm: Vec<[f32; 3]> = rd.read_normals().map(|i| i.collect()).unwrap_or_else(|| vec![[0., 1., 0.]; n]);
    let uv: Vec<[f32; 2]> = rd.read_tex_coords(0).map(|i| i.into_f32().collect()).unwrap_or_else(|| vec![[0.; 2]; n]);
    let jn: Vec<[u16; 4]> = rd.read_joints(0).expect("sin joints").into_u16().collect();
    let wt: Vec<[f32; 4]> = rd.read_weights(0).expect("sin weights").into_f32().collect();
    let idx: Vec<u32> = rd.read_indices().unwrap().into_u32().collect();
    assert!(nb <= 255, "mas de 255 huesos");

    let mut vb: Vec<u8> = Vec::with_capacity(n * 40);
    for i in 0..n {
        for v in pos[i].iter().chain(nrm[i].iter()).chain(uv[i].iter()) {
            vb.extend_from_slice(&v.to_le_bytes());
        }
        for k in 0..4 {
            vb.push(jn[i][k] as u8);
        }
        // Pesos normalizados a 8 bits (la suma debe seguir en 255).
        let s: f32 = wt[i].iter().sum::<f32>().max(1e-6);
        let mut q = [0u8; 4];
        for k in 0..4 {
            q[k] = (wt[i][k] / s * 255.0).round() as u8;
        }
        let diff = 255i32 - q.iter().map(|&x| x as i32).sum::<i32>();
        let big = (0..4).max_by_key(|&k| q[k]).unwrap();
        q[big] = (q[big] as i32 + diff).clamp(0, 255) as u8;
        vb.extend_from_slice(&q);
    }
    let ib: Vec<u8> = idx.iter().flat_map(|i| i.to_le_bytes()).collect();

    // Jerarquia: padre de cada nodo y orden topologico (raices primero).
    let mut parent: HashMap<usize, usize> = HashMap::new();
    for nd in doc.nodes() {
        for c in nd.children() {
            parent.insert(c.index(), nd.index());
        }
    }
    let nn = doc.nodes().count();
    let rest: Vec<Trs> = doc
        .nodes()
        .map(|nd| {
            let (t, r, s) = nd.transform().decomposed();
            Trs(Vec3::from(t), Quat::from_array(r), Vec3::from(s))
        })
        .collect();
    let mut order: Vec<usize> = Vec::with_capacity(nn);
    {
        fn visit(nd: gltf::Node, out: &mut Vec<usize>) {
            out.push(nd.index());
            for c in nd.children() {
                visit(c, out);
            }
        }
        let scene = doc.default_scene().or_else(|| doc.scenes().next()).unwrap();
        for r in scene.nodes() {
            visit(r, &mut order);
        }
    }

    let mut mats: Vec<u8> = vec![];
    let mut clips_json: Vec<String> = vec![];
    let mut first_frame = 0u32;
    let mut bind_pose_world: Option<Vec<Mat4>> = None;
    for anim in doc.animations() {
        let mut chans: HashMap<usize, Vec<Chan>> = HashMap::new();
        let mut dur = 0f32;
        for ch in anim.channels() {
            let r = ch.reader(|b| Some(&bufs[b.index()]));
            let times: Vec<f32> = r.read_inputs().unwrap().collect();
            dur = dur.max(*times.last().unwrap_or(&0.0));
            // Interpolacion cubica: cada clave trae 3 valores (tangentes y valor); se usa el central.
            let cubic = ch.sampler().interpolation() == gltf::animation::Interpolation::CubicSpline;
            let pick = |v: usize| if cubic { v / 3 * 3 + 1 } else { v };
            let c = match r.read_outputs().unwrap() {
                RO::Translations(it) => {
                    let all: Vec<Vec3> = it.map(Vec3::from).collect();
                    Chan::T(times.clone(), (0..times.len()).map(|k| all[pick(if cubic { k * 3 } else { k })]).collect())
                }
                RO::Rotations(it) => {
                    let all: Vec<Quat> = it.into_f32().map(Quat::from_array).collect();
                    Chan::R(times.clone(), (0..times.len()).map(|k| all[pick(if cubic { k * 3 } else { k })]).collect())
                }
                RO::Scales(it) => {
                    let all: Vec<Vec3> = it.map(Vec3::from).collect();
                    Chan::S(times.clone(), (0..times.len()).map(|k| all[pick(if cubic { k * 3 } else { k })]).collect())
                }
                _ => continue,
            };
            chans.entry(ch.target().node().index()).or_default().push(c);
        }
        let frames = ((dur * fps).ceil() as u32).max(1) + 1;
        for f in 0..frames {
            let t = f as f32 / fps;
            let mut world = vec![Mat4::IDENTITY; nn];
            for &ni in &order {
                let mut trs = rest[ni];
                if let Some(cs) = chans.get(&ni) {
                    for c in cs {
                        match c {
                            Chan::T(ts, v) => trs.0 = sample_vec(ts, v, t),
                            Chan::R(ts, v) => trs.1 = sample_quat(ts, v, t),
                            Chan::S(ts, v) => trs.2 = sample_vec(ts, v, t),
                        }
                    }
                }
                let local = Mat4::from_scale_rotation_translation(trs.2, trs.1, trs.0);
                world[ni] = match parent.get(&ni) {
                    Some(&p) => world[p] * local,
                    None => local,
                };
            }
            for (j, &ji) in joints.iter().enumerate() {
                let m = world[ji] * ibm[j];
                let c = m.to_cols_array_2d();
                // Tres filas (vec4) de la matriz 4x3: fila r = (c0[r], c1[r], c2[r], c3[r]).
                for r in 0..3 {
                    for k in 0..4 {
                        mats.extend_from_slice(&c[k][r].to_le_bytes());
                    }
                }
            }
            if bind_pose_world.is_none() {
                bind_pose_world = Some(joints.iter().enumerate().map(|(j, &ji)| world[ji] * ibm[j]).collect());
            }
        }
        println!("  clip {:?}: {} fotogramas", anim.name().unwrap_or("?"), frames);
        clips_json.push(format!(
            r#"{{"name":{:?},"first":{},"frames":{},"fps":{},"dur":{}}}"#,
            anim.name().unwrap_or("clip"), first_frame, frames, fps, dur
        ));
        first_frame += frames;
    }
    if clips_json.is_empty() {
        // Sin animaciones: un unico fotograma en reposo.
        let mut world = vec![Mat4::IDENTITY; nn];
        for &ni in &order {
            let t = rest[ni];
            let local = Mat4::from_scale_rotation_translation(t.2, t.1, t.0);
            world[ni] = match parent.get(&ni) {
                Some(&p) => world[p] * local,
                None => local,
            };
        }
        for (j, &ji) in joints.iter().enumerate() {
            let c = (world[ji] * ibm[j]).to_cols_array_2d();
            for r in 0..3 {
                for k in 0..4 {
                    mats.extend_from_slice(&c[k][r].to_le_bytes());
                }
            }
        }
        clips_json.push(format!(r#"{{"name":"reposo","first":0,"frames":1,"fps":{fps},"dur":0}}"#));
    }

    // Caja en reposo (primer fotograma del primer clip) para radio de culling y altura.
    let bp = bind_pose_world.unwrap_or_else(|| ibm.iter().map(|_| Mat4::IDENTITY).collect());
    let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for i in 0..n {
        let mut p = Vec3::ZERO;
        for k in 0..4 {
            let w = wt[i][k];
            if w > 0.0 {
                p += bp[jn[i][k] as usize].transform_point3(Vec3::from(pos[i])) * w;
            }
        }
        lo = lo.min(p);
        hi = hi.max(p);
    }
    let radius = ((hi - lo) * 0.5).length();

    // Textura base (primera imagen del material).
    let mat = prim.material();
    let img = match mat.pbr_metallic_roughness().base_color_texture() {
        Some(t) => super::to_rgba(&imgs[t.texture().source().index()]),
        None => image::RgbaImage::from_pixel(1, 1, image::Rgba([200, 200, 200, 255])),
    };
    let tex = super::pack_mips(&img, tex_size);
    let mips = (tex_size as f32).log2() as u32 + 1;

    fs::create_dir_all(out).unwrap();
    fs::write(format!("{out}/skin_verts.bin"), &vb).unwrap();
    fs::write(format!("{out}/skin_idx.bin"), &ib).unwrap();
    fs::write(format!("{out}/skin_mats.bin"), &mats).unwrap();
    fs::write(format!("{out}/skin_tex.bin"), &tex).unwrap();
    fs::write(
        format!("{out}/skin.json"),
        format!(
            r#"{{"vertices":{},"indices":{},"bones":{},"frames":{},"tex_size":{},"tex_mips":{},"radius":{},"height":{},"clips":[{}]}}"#,
            n, idx.len(), nb, first_frame.max(1), tex_size, mips, radius, hi.y - lo.y, clips_json.join(",")
        ),
    )
    .unwrap();
    println!("  {n} vertices, {} huesos, {} fotogramas, {:.1} MB de matrices", nb, first_frame, mats.len() as f32 / 1e6);
}
