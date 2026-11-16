//! Phoenix: escena GPU-driven en WebGPU.
//! Varios modelos de muy alta resolucion con cadena de LOD (bake offline), seleccion de LOD por
//! error en pantalla, frustum culling y generacion de draws en 3 pasadas de compute
//! (count -> scan -> scatter). La CPU solo sube la camara y encola draws indirectos.
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use std::{cell::Cell, rc::Rc};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
const FOV: f32 = 1.1;
const SH_RES: u32 = 2048;
const MAX_LIGHTS: u32 = 512;
const CLUSTERS: u32 = 16 * 9 * 24;
/// Radios (m) de las dos cascadas de sombras del sol, alrededor de la camara.
const CASCADES: [f32; 2] = [25.0, 130.0];

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Globals {
    view_proj: [f32; 16],
    cam: [f32; 4],
    planes: [[f32; 4]; 6],
    misc: [f32; 4],
    light: [f32; 4],
    inv_vp: [f32; 16],
    grid: [f32; 4],
    vw: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ShU {
    vp: [[f32; 16]; 2],
    split: [f32; 4],
    sun: [f32; 4],
    texel: [f32; 4],
}

/// Una vista de sombras: su propio culling GPU (count/scan/scatter) y su cola de draws.
struct SView {
    globals: wgpu::Buffer,
    args: wgpu::Buffer,
    cur: wgpu::Buffer,
    cull_bg: wgpu::BindGroup,
    bundle: wgpu::RenderBundle,
    layer: wgpu::TextureView,
}

struct Ts {
    qs: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    period: f32,
}

#[wasm_bindgen]
#[allow(dead_code)]
pub struct Phoenix {
    surface: wgpu::Surface<'static>,
    cfg: wgpu::SurfaceConfiguration,
    device: wgpu::Device,
    queue: wgpu::Queue,
    depth: wgpu::TextureView,
    globals: wgpu::Buffer,
    args: wgpu::Buffer,
    cur: wgpu::Buffer,
    staging: wgpu::Buffer,
    count_pl: wgpu::ComputePipeline,
    scan_pl: wgpu::ComputePipeline,
    scatter_pl: wgpu::ComputePipeline,
    cull_bg: wgpu::BindGroup,
    draw_pl: wgpu::RenderPipeline,
    cluster_pl: wgpu::ComputePipeline,
    lights_buf: wgpu::Buffer,
    sh_buf: wgpu::Buffer,
    sviews: Vec<SView>,
    nlights: u32,
    sun: [f32; 4],
    sh_on: bool,
    /// Los draws indirectos no cambian entre frames: se graban una sola vez.
    bundle: wgpu::RenderBundle,
    draw_bg: wgpu::BindGroup,
    vis_bg: wgpu::BindGroup,
    vbuf: wgpu::Buffer,
    ibuf: wgpu::Buffer,
    // Argumentos indirectos iniciales (instance_count y first_instance a 0).
    args0: Vec<u32>,
    zeros: Vec<u32>,
    n: u32,
    models: u32,
    lods: u32,
    frame: u64,
    tau: f32,
    spacing: f32,
    flat: bool,
    textured: bool,
    tex_bg: wgpu::BindGroup,
    gnd_bg: wgpu::BindGroup,
    ground_pl: wgpu::RenderPipeline,
    sky_pl: wgpu::RenderPipeline,
    busy: Rc<Cell<bool>>,
    // [visibles, tris dibujados, tris a resolucion completa, draws no vacios, cull ms, render ms]
    stats: Rc<Cell<[f64; 6]>>,
    ts: Option<Ts>,
    tris: Rc<Vec<u32>>,
    full: Rc<Vec<u32>>,
}

fn depth_view(d: &wgpu::Device, w: u32, h: u32) -> wgpu::TextureView {
    d.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: DEPTH,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    })
    .create_view(&Default::default())
}

fn entry(ty: wgpu::BufferBindingType, binding: u32, vis: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: vis,
        ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

fn err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// `draws`: [index_count, first_index, base_vertex] por (modelo, lod), modelo-major.
/// `info`: 8 floats por modelo (radio, error de cada LOD).
/// Textura 2D en array con su cadena de mips (capas una tras otra, cada una con todos sus mips).
fn make_tex(
    device: &wgpu::Device, queue: &wgpu::Queue, size: u32, mips: u32, layers: u32,
    fmt: wgpu::TextureFormat, data: &[u8],
) -> wgpu::TextureView {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: layers },
        mip_level_count: mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: fmt,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let mut off = 0usize;
    for layer in 0..layers {
        let mut s = size;
        for mip in 0..mips {
            let bytes = (s * s * 4) as usize;
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &tex, mip_level: mip,
                    origin: wgpu::Origin3d { x: 0, y: 0, z: layer },
                    aspect: wgpu::TextureAspect::All,
                },
                &data[off..off + bytes],
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(s * 4), rows_per_image: Some(s) },
                wgpu::Extent3d { width: s, height: s, depth_or_array_layers: 1 },
            );
            off += bytes;
            s = (s / 2).max(1);
        }
    }
    tex.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    })
}

#[wasm_bindgen]
pub async fn create(
    canvas: web_sys::HtmlCanvasElement,
    verts: &[u8],
    idx: &[u8],
    info: &[f32],
    draws: &[u32],
    models: u32,
    lods: u32,
    count: u32,
    flat: bool,
    tex_size: u32,
    tex_mips: u32,
    tex_layers: u32,
    tex_base: &[u8],
    tex_norm: &[u8],
    tex_orm: &[u8],
    ground_size: u32,
    ground_mips: u32,
    ground_base: &[u8],
    ground_norm: &[u8],
) -> Result<Phoenix, JsValue> {
    console_error_panic_hook::set_once();
    let (w, h) = (canvas.width().max(1), canvas.height().max(1));
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas)).map_err(err)?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            ..Default::default()
        })
        .await
        .map_err(err)?;
    if !adapter.features().contains(wgpu::Features::INDIRECT_FIRST_INSTANCE) {
        return Err("el adaptador no soporta indirect-first-instance".into());
    }
    let max = adapter.limits();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            required_features: wgpu::Features::INDIRECT_FIRST_INSTANCE
                | (adapter.features() & wgpu::Features::TIMESTAMP_QUERY),
            required_limits: wgpu::Limits {
                max_buffer_size: max.max_buffer_size,
                max_storage_buffer_binding_size: max.max_storage_buffer_binding_size,
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .map_err(err)?;

    let mut cfg = surface.get_default_config(&adapter, w, h).ok_or("superficie sin config")?;
    cfg.present_mode = wgpu::PresentMode::AutoVsync;
    surface.configure(&device, &cfg);

    let vbuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None, contents: verts, usage: wgpu::BufferUsages::VERTEX,
    });
    let ibuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None, contents: idx, usage: wgpu::BufferUsages::INDEX,
    });
    let info_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None, contents: bytemuck::cast_slice(info), usage: wgpu::BufferUsages::STORAGE,
    });

    // Instancias en rejilla: colinas con rocas, o plano con estatuas apoyadas en el suelo.
    let spacing = if flat { 3.2 } else { 4.0 };
    let side = (count as f32).sqrt().ceil() as u32;
    let mut insts: Vec<[f32; 4]> = Vec::with_capacity(count as usize * 2);
    let hs = |i: u32, k: u32| {
        // Hash con buen mezclado: sin correlacion entre canales k.
        let mut h = i.wrapping_mul(0x9E3779B1) ^ k.wrapping_mul(0x85EBCA6B);
        h ^= h >> 16;
        h = h.wrapping_mul(0x7FEB352D);
        h ^= h >> 15;
        h = h.wrapping_mul(0x846CA68B);
        h ^= h >> 16;
        (h & 0xffffff) as f32 / 16777215.0
    };
    // Escena cinematografica: estatua heroe en el origen, rocas, y un ejercito de estatuas en
    // bloques de 8 columnas separados por pasillos (un pasillo en x = 0).
    let rocks = if flat { 60000u32.min(count / 4) } else { 0 };
    let ns = count - rocks;
    let off = |m: usize| info[m * 16 + 13];
    let hgt = |m: usize| info[m * 16 + 14];
    let s_statue = 4.6 / hgt(0);
    let (nb, cols) = (60u32, 480u32);
    for i in 0..count {
        if flat {
            let (a, b) = if i == 0 {
                ([0.0, s_statue * off(0), 0.0, s_statue], [0.0, 0.0, 0.5, 0.0])
            } else if i >= ns {
                let r = i - ns;
                let (x, z, s) = if r < 40 {
                    // Rocas grandes detras de la estatua heroe.
                    ((hs(i, 1) - 0.5) * 70.0, 12.0 + hs(i, 2) * 38.0, 2.5 + hs(i, 3) * 3.5)
                } else if r < 3000 {
                    // Escombros alrededor de la estatua: muchos pequenos, pocos grandes.
                    let (an, rad) = (hs(i, 1) * 6.2832, 4.0 + hs(i, 2) * 55.0);
                    let q = hs(i, 3);
                    (an.cos() * rad, an.sin() * rad, 0.12 + q * q * q * 2.6)
                } else if r < 32000 {
                    // Guijarros en el pasillo central.
                    ((hs(i, 1) - 0.5) * 6.5, -70.0 - hs(i, 2) * 900.0, 0.07 + hs(i, 3) * hs(i, 3) * 0.3)
                } else {
                    ((hs(i, 1) - 0.5) * 1500.0, -80.0 - hs(i, 2) * 4000.0, 0.3 + hs(i, 3) * hs(i, 3) * 3.0)
                };
                let mi = 1 + (i as usize % (models as usize - 1));
                ([x, s * (off(mi) - 0.22), z, s], [mi as f32, hs(i, 4) * 6.2832, hs(i, 5), 0.0])
            } else {
                let k = i - 1;
                let (c, r) = (k % cols, k / cols);
                let (bl, kk) = (c / 8, c % 8);
                let center = (bl as f32 - nb as f32 / 2.0 + 0.5) * 23.6;
                let x = center + (kk as f32 - 3.5) * 2.2;
                let s = s_statue * (0.98 + hs(i, 3) * 0.04);
                ([x, s * off(0), -80.0 - r as f32 * 3.6, s], [0.0, (hs(i, 4) - 0.5) * 0.15, hs(i, 5), 0.0])
            };
            insts.push(a);
            insts.push(b);
            continue;
        }
        let (gx, gz) = ((i % side) as f32 * spacing, (i / side) as f32 * spacing);
        let jit = if flat { 0.6 } else { 3.0 };
        let (x, z) = (gx + (hs(i, 1) - 0.5) * jit, gz + (hs(i, 2) - 0.5) * jit);
        let (s, y) = if flat {
            let s = 0.9 + hs(i, 3) * 0.8;
            (s, s * 0.947)
        } else {
            let s = 0.8 + hs(i, 3) * hs(i, 3) * 3.0;
            let ground = 14.0 * (x * 0.006).sin() * (z * 0.008).cos() + 5.0 * (x * 0.02 + z * 0.015).sin();
            (s, ground + s * 0.5)
        };
        insts.push([x, y, z, s]);
        insts.push([(i.wrapping_mul(0x9E3779B1) >> 16) as f32 % models as f32, hs(i, 4) * 6.2832, hs(i, 5), 0.0]);
    }
    let inst_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None, contents: bytemuck::cast_slice(&insts), usage: wgpu::BufferUsages::STORAGE,
    });

    let nd = (models * lods) as usize;
    let mut args0 = vec![0u32; nd * 5];
    let mut tris = vec![0u32; nd];
    let mut full = vec![0u32; nd];
    for d in 0..nd {
        args0[d * 5] = draws[d * 3];
        args0[d * 5 + 2] = draws[d * 3 + 1];
        args0[d * 5 + 3] = draws[d * 3 + 2];
        tris[d] = draws[d * 3] / 3;
        full[d] = draws[(d / lods as usize) * lods as usize * 3] / 3;
    }
    let globals = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: size_of::<Globals>() as u64, mapped_at_creation: false,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let args = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: (nd * 20) as u64, mapped_at_creation: false,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT
            | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
    });
    let cur = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: (nd * 4) as u64, mapped_at_creation: false,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
    });
    let stage_size = ((nd * 20 + 63) / 64 * 64 + 32) as u64;
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: stage_size, mapped_at_creation: false,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
    });
    let vis = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: count as u64 * 8, mapped_at_creation: false, // hasta 2 copias por instancia (fundido de LOD)
        usage: wgpu::BufferUsages::STORAGE,
    });

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None, source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
    });
    use wgpu::{BufferBindingType as B, ShaderStages as S};
    let uni = |vis| wgpu::BindGroupLayoutEntry {
        binding: 0, visibility: vis, count: None,
        ty: wgpu::BindingType::Buffer { ty: B::Uniform, has_dynamic_offset: false, min_binding_size: None },
    };
    let ro = B::Storage { read_only: true };
    let rw = B::Storage { read_only: false };
    let cull_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            uni(S::COMPUTE), entry(ro, 1, S::COMPUTE), entry(ro, 2, S::COMPUTE),
            entry(rw, 3, S::COMPUTE), entry(rw, 4, S::COMPUTE), entry(rw, 5, S::COMPUTE),
        ],
    });
    let draw_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[uni(S::VERTEX | S::FRAGMENT), entry(ro, 1, S::VERTEX)],
    });
    let vis_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None, entries: &[entry(ro, 0, S::VERTEX)],
    });
    let bind = |l: &wgpu::BindGroupLayout, bs: &[(u32, &wgpu::Buffer)]| {
        let e: Vec<_> = bs
            .iter()
            .map(|&(binding, b)| wgpu::BindGroupEntry { binding, resource: b.as_entire_binding() })
            .collect();
        device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: l, entries: &e })
    };
    let cull_bg = bind(&cull_l, &[(0, &globals), (1, &inst_buf), (2, &info_buf), (3, &args), (4, &cur), (5, &vis)]);
    let draw_bg = bind(&draw_l, &[(0, &globals), (1, &inst_buf)]);
    let vis_bg = bind(&vis_l, &[(0, &vis)]);

    // Texturas (base sRGB, normal, ORM); si no hay, texturas de 1x1.
    let textured = tex_layers > 0;
    let (tsz, tmips, tlayers) = if textured { (tex_size, tex_mips, tex_layers) } else { (1, 1, 1) };
    let dummy = [255u8; 4];
    let tv = |fmt, data: &[u8]| make_tex(&device, &queue, tsz, tmips, tlayers, fmt, if textured { data } else { &dummy });
    let t_base = tv(wgpu::TextureFormat::Rgba8UnormSrgb, tex_base);
    let t_norm = tv(wgpu::TextureFormat::Rgba8Unorm, tex_norm);
    let t_orm = tv(wgpu::TextureFormat::Rgba8Unorm, tex_orm);
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        anisotropy_clamp: 8,
        ..Default::default()
    });
    let tex_entry = |binding| wgpu::BindGroupLayoutEntry {
        binding, visibility: S::FRAGMENT, count: None,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2Array,
            multisampled: false,
        },
    };
    let tex_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            tex_entry(0), tex_entry(1), tex_entry(2),
            wgpu::BindGroupLayoutEntry {
                binding: 3, visibility: S::FRAGMENT, count: None,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            },
        ],
    });
    let tex_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None, layout: &tex_l,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&t_base) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&t_norm) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&t_orm) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&sampler) },
        ],
    });

    let gnd_ok = ground_size > 0;
    let (gs, gm) = if gnd_ok { (ground_size, ground_mips) } else { (1, 1) };
    let gtv = |fmt, data: &[u8]| make_tex(&device, &queue, gs, gm, 1, fmt, if gnd_ok { data } else { &dummy });
    let g_base = gtv(wgpu::TextureFormat::Rgba8UnormSrgb, ground_base);
    let g_norm = gtv(wgpu::TextureFormat::Rgba8Unorm, ground_norm);
    // Grupo 3: suelo + sombras + luces (compartido por suelo y por el pase principal y el clustering).
    let sh_tex = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: SH_RES, height: SH_RES, depth_or_array_layers: 2 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: DEPTH,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let sh_view = sh_tex.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default()
    });
    let sh_layer = |i: u32| sh_tex.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2), base_array_layer: i, array_layer_count: Some(1),
        ..Default::default()
    });
    let cmp = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
        compare: Some(wgpu::CompareFunction::LessEqual), ..Default::default()
    });
    let lights_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: (MAX_LIGHTS * 32) as u64, mapped_at_creation: false,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
    });
    let cl_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: (CLUSTERS * 32 * 4) as u64, mapped_at_creation: false,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let sh_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: size_of::<ShU>() as u64, mapped_at_creation: false,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let gnd_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            tex_entry(0), tex_entry(1),
            wgpu::BindGroupLayoutEntry {
                binding: 2, visibility: S::FRAGMENT, count: None,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3, visibility: S::FRAGMENT, count: None,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2Array,
                    multisampled: false,
                },
            },
            wgpu::BindGroupLayoutEntry {
                binding: 4, visibility: S::FRAGMENT, count: None,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
            },
            entry(B::Uniform, 5, S::FRAGMENT),
            entry(ro, 6, S::FRAGMENT | S::COMPUTE),
            entry(rw, 7, S::FRAGMENT | S::COMPUTE),
        ],
    });
    let gnd_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None, layout: &gnd_l,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&g_base) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&g_norm) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&sh_view) },
            wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&cmp) },
            wgpu::BindGroupEntry { binding: 5, resource: sh_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: lights_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 7, resource: cl_buf.as_entire_binding() },
        ],
    });

    let cull_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None, bind_group_layouts: &[Some(&cull_l)], immediate_size: 0,
    });
    let cpl = |entry_point: &str| {
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None, layout: Some(&cull_layout), module: &module,
            entry_point: Some(entry_point), compilation_options: Default::default(), cache: None,
        })
    };
    let (count_pl, scan_pl, scatter_pl) = (cpl("count"), cpl("scan"), cpl("scatter"));
    let draw_pl = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[Some(&draw_l), Some(&vis_l), Some(&tex_l), Some(&gnd_l)], immediate_size: 0,
        })),
        vertex: wgpu::VertexState {
            module: &module, entry_point: Some("vs"), compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 20,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[
                    wgpu::VertexAttribute { format: wgpu::VertexFormat::Snorm16x4, offset: 0, shader_location: 0 },
                    wgpu::VertexAttribute { format: wgpu::VertexFormat::Snorm16x2, offset: 8, shader_location: 1 },
                    wgpu::VertexAttribute { format: wgpu::VertexFormat::Snorm16x2, offset: 12, shader_location: 2 },
                    wgpu::VertexAttribute { format: wgpu::VertexFormat::Unorm16x2, offset: 16, shader_location: 3 },
                ],
            })],
        },
        fragment: Some(wgpu::FragmentState {
            module: &module, entry_point: Some("fs"), compilation_options: Default::default(),
            targets: &[Some(cfg.format.into())],
        }),
        primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH, depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: Default::default(), bias: Default::default(),
        }),
        multisample: Default::default(), multiview_mask: None, cache: None,
    });

    let ground_pl = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[Some(&draw_l), None, None, Some(&gnd_l)], immediate_size: 0,
        })),
        vertex: wgpu::VertexState {
            module: &module, entry_point: Some("vs_ground"), compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: &module, entry_point: Some("fs_ground"), compilation_options: Default::default(),
            targets: &[Some(cfg.format.into())],
        }),
        primitive: Default::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH, depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: Default::default(), bias: Default::default(),
        }),
        multisample: Default::default(), multiview_mask: None, cache: None,
    });

    let sky_pl = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[Some(&draw_l)], immediate_size: 0,
        })),
        vertex: wgpu::VertexState {
            module: &module, entry_point: Some("vs_sky"), compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: &module, entry_point: Some("fs_sky"), compilation_options: Default::default(),
            targets: &[Some(cfg.format.into())],
        }),
        primitive: Default::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH, depth_write_enabled: Some(false),
            depth_compare: Some(wgpu::CompareFunction::Always),
            stencil: Default::default(), bias: Default::default(),
        }),
        multisample: Default::default(), multiview_mask: None, cache: None,
    });

    let cluster_pl = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[Some(&cull_l), None, None, Some(&gnd_l)], immediate_size: 0,
        })),
        module: &module, entry_point: Some("cluster_cull"), compilation_options: Default::default(), cache: None,
    });
    let shadow_pl = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[Some(&draw_l), Some(&vis_l)], immediate_size: 0,
        })),
        vertex: wgpu::VertexState {
            module: &module, entry_point: Some("vs_shadow"), compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 20,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute { format: wgpu::VertexFormat::Snorm16x4, offset: 0, shader_location: 0 }],
            })],
        },
        fragment: None,
        primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Front), ..Default::default() },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH, depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: Default::default(),
            bias: wgpu::DepthBiasState { constant: 2, slope_scale: 2.0, clamp: 0.0 },
        }),
        multisample: Default::default(), multiview_mask: None, cache: None,
    });
    let mk_view = |layer: u32| -> SView {
        let globals = device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: size_of::<Globals>() as u64, mapped_at_creation: false,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let args = device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: (nd * 20) as u64, mapped_at_creation: false,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST,
        });
        let cur = device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: (nd * 4) as u64, mapped_at_creation: false,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let svis = device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: count as u64 * 4, mapped_at_creation: false, usage: wgpu::BufferUsages::STORAGE,
        });
        let cull_bg = bind(&cull_l, &[(0, &globals), (1, &inst_buf), (2, &info_buf), (3, &args), (4, &cur), (5, &svis)]);
        let dbg = bind(&draw_l, &[(0, &globals), (1, &inst_buf)]);
        let vbg = bind(&vis_l, &[(0, &svis)]);
        let mut b = device.create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
            label: None,
            color_formats: &[],
            depth_stencil: Some(wgpu::RenderBundleDepthStencil {
                format: DEPTH, depth_read_only: false, stencil_read_only: true,
            }),
            sample_count: 1,
            multiview: None,
        });
        b.set_pipeline(&shadow_pl);
        b.set_bind_group(0, &dbg, &[]);
        b.set_bind_group(1, &vbg, &[]);
        b.set_vertex_buffer(0, vbuf.slice(..));
        b.set_index_buffer(ibuf.slice(..), wgpu::IndexFormat::Uint32);
        for d in 0..(models * lods) as u64 {
            b.draw_indexed_indirect(&args, d * 20);
        }
        let bundle = b.finish(&wgpu::RenderBundleDescriptor { label: None });
        SView { globals, args, cur, cull_bg, bundle, layer: sh_layer(layer) }
    };
    let sviews: Vec<SView> = (0..2).map(mk_view).collect();

    let ts = device.features().contains(wgpu::Features::TIMESTAMP_QUERY).then(|| Ts {
        qs: device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: 4 }),
        resolve: device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: 32, mapped_at_creation: false,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        }),
        period: queue.get_timestamp_period(),
    });
    let depth = depth_view(&device, w, h);
    let bundle = {
        let mut b = device.create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
            label: None,
            color_formats: &[Some(cfg.format)],
            depth_stencil: Some(wgpu::RenderBundleDepthStencil {
                format: DEPTH, depth_read_only: false, stencil_read_only: true,
            }),
            sample_count: 1,
            multiview: None,
        });
        b.set_pipeline(&draw_pl);
        b.set_bind_group(0, &draw_bg, &[]);
        b.set_bind_group(1, &vis_bg, &[]);
        b.set_bind_group(2, &tex_bg, &[]);
        b.set_bind_group(3, &gnd_bg, &[]);
        b.set_vertex_buffer(0, vbuf.slice(..));
        b.set_index_buffer(ibuf.slice(..), wgpu::IndexFormat::Uint32);
        for d in 0..(models * lods) as u64 {
            b.draw_indexed_indirect(&args, d * 20);
        }
        b.finish(&wgpu::RenderBundleDescriptor { label: None })
    };
    Ok(Phoenix {
        surface, cfg, device, queue, depth, globals, args, cur, staging, count_pl, scan_pl, scatter_pl,
        cull_bg, draw_pl, bundle, cluster_pl, lights_buf, sh_buf, sviews, nlights: 0,
        sun: [2.4, 2.2, 1.92, 0.9], sh_on: true, draw_bg, vis_bg, vbuf, ibuf, args0, zeros: vec![0; nd], n: count, models, lods,
        frame: 0, tau: 1.0, spacing, flat, textured, tex_bg, gnd_bg, ground_pl, sky_pl, busy: Rc::new(Cell::new(false)), stats: Rc::new(Cell::new([0.0; 6])), ts,
        tris: Rc::new(tris), full: Rc::new(full),
    })
}

#[wasm_bindgen]
impl Phoenix {
    pub fn resize(&mut self, w: u32, h: u32) {
        self.cfg.width = w.max(1);
        self.cfg.height = h.max(1);
        self.surface.configure(&self.device, &self.cfg);
        self.depth = depth_view(&self.device, self.cfg.width, self.cfg.height);
    }

    /// [visibles, tris dibujados, tris a resolucion completa, draws no vacios, cull ms, render ms]
    pub fn stats(&self) -> Vec<f64> {
        self.stats.get().to_vec()
    }

    /// Tolerancia de error del LOD en pixeles (1 = sin diferencia visible).
    pub fn set_tolerance(&mut self, px: f32) {
        self.tau = px;
    }

    /// Luces puntuales: 8 floats por luz (x, y, z, radio, r, g, b, intensidad). Maximo 512.
    /// El culling por clusters y el sombreado ocurren en la GPU; esto solo sube el buffer.
    pub fn set_lights(&mut self, data: &[f32]) {
        let n = ((data.len() / 8) as u32).min(MAX_LIGHTS);
        let mut v = Vec::with_capacity(n as usize * 8);
        for l in data.chunks_exact(8).take(n as usize) {
            v.extend_from_slice(&[l[0], l[1], l[2], l[3], l[4] * l[7], l[5] * l[7], l[6] * l[7], 0.0]);
        }
        self.queue.write_buffer(&self.lights_buf, 0, bytemuck::cast_slice(&v));
        self.nlights = n;
    }

    /// Sol: radiancia (r, g, b) y escala de la luz ambiente.
    pub fn set_sun(&mut self, r: f32, g: f32, b: f32, ambient: f32) {
        self.sun = [r, g, b, ambient];
    }

    /// Activa o desactiva las sombras del sol (2 cascadas).
    pub fn set_shadows(&mut self, on: bool) {
        self.sh_on = on;
    }

    /// Ancho y alto de la rejilla de instancias en metros.
    pub fn extent(&self) -> f32 {
        (self.n as f32).sqrt().ceil() * self.spacing
    }

    pub fn frame(&mut self, ex: f32, ey: f32, ez: f32, yaw: f32, pitch: f32) {
        let eye = Vec3::new(ex, ey, ez);
        let dir = Vec3::new(yaw.sin() * pitch.cos(), pitch.sin(), -yaw.cos() * pitch.cos());
        let aspect = self.cfg.width as f32 / self.cfg.height as f32;
        let vp = Mat4::perspective_rh(FOV, aspect, 0.3, 4000.0) * Mat4::look_to_rh(eye, dir, Vec3::Y);
        let m = vp.transpose();
        let (r0, r1, r2, r3) = (m.col(0), m.col(1), m.col(2), m.col(3));
        let planes_of = |vp: Mat4| {
            let m = vp.transpose();
            let (r0, r1, r2, r3) = (m.col(0), m.col(1), m.col(2), m.col(3));
            [r3 + r0, r3 - r0, r3 + r1, r3 - r1, r2, r3 - r2].map(|p| {
                let l = p.truncate().length();
                (p / l).to_array()
            })
        };
        let planes = planes_of(vp);
        let _ = (r0, r1, r2, r3);
        let g = Globals {
            view_proj: vp.to_cols_array(),
            cam: [ex, ey, ez, self.cfg.height as f32 / (2.0 * (FOV * 0.5).tan())],
            planes,
            misc: [self.n as f32, self.models as f32, self.lods as f32, self.tau],
            light: if self.flat {
                let l = Vec3::new(-0.7, 0.55, -0.25).normalize();
                [l.x, l.y, l.z, if self.textured { 2.0 } else { 1.0 }]
            } else {
                [0.5, 0.8, 0.3, 0.0]
            },
            inv_vp: vp.inverse().to_cols_array(),
            grid: [self.cfg.width as f32, self.cfg.height as f32, 0.3, 150.0],
            vw: [0.0, 0.0, 0.0, self.nlights as f32],
        };
        // Cascadas de sombras del sol: cajas ortograficas alineadas a la luz, ajustadas al texel.
        let shadows = self.flat && self.textured && self.sh_on;
        let mut shu = ShU::zeroed();
        shu.sun = self.sun;
        if shadows {
            let sun_l = Vec3::new(-0.7, 0.55, -0.25).normalize();
            let lview = Mat4::look_to_rh(Vec3::ZERO, -sun_l, Vec3::Y);
            for (i, rr) in CASCADES.into_iter().enumerate() {
                let c = lview.transform_point3(eye + dir * rr * 0.5);
                let texel = 2.0 * rr / SH_RES as f32;
                let (cx, cy) = ((c.x / texel).floor() * texel, (c.y / texel).floor() * texel);
                let proj = Mat4::orthographic_rh(cx - rr, cx + rr, cy - rr, cy + rr, -c.z - 300.0, -c.z + rr * 1.3);
                let svp = proj * lview;
                let mut gc = g;
                gc.view_proj = svp.to_cols_array();
                gc.planes = planes_of(svp);
                gc.inv_vp = svp.inverse().to_cols_array();
                gc.misc[3] = 1.5;
                gc.vw = [1.0, SH_RES as f32 / (2.0 * rr), 1.0, 0.0];
                let sv = &self.sviews[i];
                self.queue.write_buffer(&sv.globals, 0, bytemuck::bytes_of(&gc));
                self.queue.write_buffer(&sv.args, 0, bytemuck::cast_slice(&self.args0));
                self.queue.write_buffer(&sv.cur, 0, bytemuck::cast_slice(&self.zeros));
                shu.vp[i] = svp.to_cols_array();
                shu.texel[i] = texel;
            }
            shu.split = [CASCADES[0] * 1.2, CASCADES[1] * 1.2, 0.0, 1.0];
            shu.texel[2] = 1.0 / SH_RES as f32;
        }
        self.queue.write_buffer(&self.sh_buf, 0, bytemuck::bytes_of(&shu));
        self.queue.write_buffer(&self.globals, 0, bytemuck::bytes_of(&g));
        self.queue.write_buffer(&self.args, 0, bytemuck::cast_slice(&self.args0));
        self.queue.write_buffer(&self.cur, 0, bytemuck::cast_slice(&self.zeros));

        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            _ => {
                self.surface.configure(&self.device, &self.cfg);
                return;
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let mut enc = self.device.create_command_encoder(&Default::default());
        let groups = self.n.div_ceil(64);
        let tw = |i: u32| self.ts.as_ref().map(|t| (&t.qs, i));
        {
            // Una sola pasada con los tres dispatches (WebGPU los ordena dentro de la pasada).
            let mut p = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: tw(0).map(|(qs, _)| wgpu::ComputePassTimestampWrites {
                    query_set: qs,
                    beginning_of_pass_write_index: Some(0),
                    end_of_pass_write_index: Some(1),
                }),
            });
            let views = std::iter::once(&self.cull_bg).chain(self.sviews.iter().take(if shadows { 2 } else { 0 }).map(|v| &v.cull_bg));
            for bg in views {
                p.set_bind_group(0, bg, &[]);
                for (k, pl) in [&self.count_pl, &self.scan_pl, &self.scatter_pl].into_iter().enumerate() {
                    p.set_pipeline(pl);
                    p.dispatch_workgroups(if k == 1 { 1 } else { groups }, 1, 1);
                }
            }
            if self.nlights > 0 {
                p.set_pipeline(&self.cluster_pl);
                p.set_bind_group(0, &self.cull_bg, &[]);
                p.set_bind_group(3, &self.gnd_bg, &[]);
                p.dispatch_workgroups(CLUSTERS.div_ceil(64), 1, 1);
            }
        }
        if shadows {
            for sv in &self.sviews {
                let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: None,
                    color_attachments: &[],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &sv.layer,
                        depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                        stencil_ops: None,
                    }),
                    ..Default::default()
                });
                p.execute_bundles([&sv.bundle]);
            }
        }
        {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view, depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.80, g: 0.77, b: 0.71, a: 1.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: self.ts.as_ref().map(|t| wgpu::RenderPassTimestampWrites {
                    query_set: &t.qs,
                    beginning_of_pass_write_index: Some(2),
                    end_of_pass_write_index: Some(3),
                }),
                ..Default::default()
            });
            p.set_bind_group(3, &self.gnd_bg, &[]);
            if self.flat {
                p.set_pipeline(&self.sky_pl);
                p.set_bind_group(0, &self.draw_bg, &[]);
                p.draw(0..3, 0..1);
                p.set_pipeline(&self.ground_pl);
                p.set_bind_group(0, &self.draw_bg, &[]);
                p.set_bind_group(3, &self.gnd_bg, &[]);
                p.draw(0..6, 0..1);
            }
            p.execute_bundles([&self.bundle]);
        }
        let read = self.frame % 45 == 0 && !self.busy.get();
        let nd = (self.models * self.lods) as usize;
        let ts_off = ((nd * 20 + 63) / 64 * 64) as u64;
        if read {
            enc.copy_buffer_to_buffer(&self.args, 0, &self.staging, 0, (nd * 20) as u64);
            if let Some(t) = &self.ts {
                enc.resolve_query_set(&t.qs, 0..4, &t.resolve, 0);
                enc.copy_buffer_to_buffer(&t.resolve, 0, &self.staging, ts_off, 32);
            }
        }
        self.queue.submit([enc.finish()]);
        self.queue.present(frame);
        if read {
            self.busy.set(true);
            let (busy, stats, st) = (self.busy.clone(), self.stats.clone(), self.staging.clone());
            let (tris, full) = (self.tris.clone(), self.full.clone());
            let period = self.ts.as_ref().map(|t| t.period);
            self.staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                if r.is_ok() {
                    let d = st.slice(..).get_mapped_range().unwrap();
                    let u: &[u32] = bytemuck::cast_slice(&d[..nd * 20]);
                    let (mut vis, mut drawn, mut fullres, mut used) = (0f64, 0f64, 0f64, 0f64);
                    for k in 0..nd {
                        let c = u[k * 5 + 1] as f64;
                        vis += c;
                        drawn += c * tris[k] as f64;
                        fullres += c * full[k] as f64;
                        if c > 0.0 { used += 1.0; }
                    }
                    let mut s = stats.get();
                    s[..4].copy_from_slice(&[vis, drawn, fullres, used]);
                    if let Some(p) = period {
                        let t: &[u64] = bytemuck::cast_slice(&d[ts_off as usize..ts_off as usize + 32]);
                        let ms = |a: u64, b: u64| b.saturating_sub(a) as f64 * p as f64 * 1e-6;
                        s[4] = ms(t[0], t[1]);
                        s[5] = ms(t[2], t[3]);
                    }
                    stats.set(s);
                    drop(d);
                    st.unmap();
                }
                busy.set(false);
            });
        }
        self.frame += 1;
    }
}
