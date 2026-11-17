//! Phoenix: escena GPU-driven en WebGPU.
//! Varios modelos de muy alta resolucion con cadena de LOD (bake offline), seleccion de LOD por
//! error en pantalla, frustum culling y generacion de draws en 3 pasadas de compute
//! (count -> scan -> scatter). La CPU solo sube la camara y encola draws indirectos.
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use lux::Lux;
use std::{cell::Cell, rc::Rc};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

mod particles;
mod skin;
use skin::{SkinModel, SkinSys};
use particles::Particles;

const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
const FOV: f32 = 1.1;
/// Formato del buffer HDR de la escena (el post-proceso lo compone en pantalla).
const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;


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
    prev_vp: [f32; 16],
    vw: [f32; 4],
    /// x = diametro minimo en pixeles para dibujar una instancia
    tune: [f32; 4],
}

/// Una vista de sombras: su propio culling GPU (count/scan/scatter) y su cola de draws.
struct SView {
    globals: wgpu::Buffer,
    args: wgpu::Buffer,
    cur: wgpu::Buffer,
    cull_bg: wgpu::BindGroup,
    bundle: wgpu::RenderBundle,
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
    tg: Targets,
    post: PostRes,
    /// [bloom, fuerza del AO, radio del AO]
    post_k: [f32; 3],
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
    lux: Lux,
    sviews: Vec<SView>,
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
    capacity: u32,
    hiz: Hiz,
    hiz_res: HizRes,
    prev_vp: Mat4,
    hiz_on: bool,
    hiz_ready: bool,
    min_px: f32,
    far_tol: f32,
    env_on: bool,
    inst_buf: wgpu::Buffer,
    chunks: wgpu::Buffer,
    chunk_pl: wgpu::ComputePipeline,
    dirty: bool,
    flat: bool,
    textured: bool,
    tex_bg: wgpu::BindGroup,
    gnd_bg: wgpu::BindGroup,
    ground_pl: wgpu::RenderPipeline,
    sky_pl: wgpu::RenderPipeline,
    busy: Rc<Cell<bool>>,
    // [visibles, tris dibujados, tris a resolucion completa, draws no vacios, cull ms, render ms]
    stats: Rc<Cell<[f64; 8]>>,
    ts: Option<Ts>,
    tris: Rc<Vec<u32>>,
    full: Rc<Vec<u32>>,
    parts: Particles,
    skin_sys: SkinSys,
    skins: Vec<SkinModel>,
}

thread_local! {
    /// Ultimo error de GPU no capturado o motivo de perdida del dispositivo (para el anfitrion).
    static GPU_STATUS: std::cell::RefCell<(bool, String)> = const { std::cell::RefCell::new((false, String::new())) };
}

fn depth_view(d: &wgpu::Device, w: u32, h: u32) -> wgpu::TextureView {
    d.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: DEPTH,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
    .create_view(&Default::default())
}

/// Texturas de pantalla completa del post-proceso y sus bind groups (se recrean al redimensionar).
struct Targets {
    hdr: wgpu::TextureView,
    ao: wgpu::TextureView,
    bloom: Vec<wgpu::TextureView>,
    bg_ao: wgpu::BindGroup,
    bg_down: Vec<wgpu::BindGroup>,
    bg_comp: wgpu::BindGroup,
}

/// Piramide Hi-Z (R32Float; nivel 0 = mitad de resolucion) y sus bind groups de generacion.
struct Hiz {
    #[allow(dead_code)]
    all: wgpu::TextureView,
    levels: Vec<wgpu::TextureView>,
    gen_bg: Vec<wgpu::BindGroup>,
    cull_bg: wgpu::BindGroup,
}

struct HizRes {
    gen_l: wgpu::BindGroupLayout,
    cull_l: wgpu::BindGroupLayout,
    dummy: wgpu::TextureView,
    pl0: wgpu::RenderPipeline,
    pln: wgpu::RenderPipeline,
}

fn make_hiz(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, depth: &wgpu::TextureView, r: &HizRes) -> Hiz {
    let (w0, h0) = (w.div_ceil(2).max(1), h.div_ceil(2).max(1));
    let mips = 32 - w0.max(h0).leading_zeros();
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: w0, height: h0, depth_or_array_layers: 1 },
        mip_level_count: mips, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let all = tex.create_view(&Default::default());
    let levels: Vec<_> = (0..mips)
        .map(|k| tex.create_view(&wgpu::TextureViewDescriptor { base_mip_level: k, mip_level_count: Some(1), ..Default::default() }))
        .collect();
    let gen_bg: Vec<_> = (0..mips as usize)
        .map(|k| {
            let src = if k == 0 { &r.dummy } else { &levels[k - 1] };
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None, layout: &r.gen_l,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(depth) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(src) },
                ],
            })
        })
        .collect();
    let cull_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None, layout: &r.cull_l,
        entries: &[wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&all) }],
    });
    // Inicializa a 1.0 (todo lejano) para que el primer frame no oculte nada.
    let mut enc = device.create_command_encoder(&Default::default());
    for v in &levels {
        enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: v, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
    }
    queue.submit([enc.finish()]);
    Hiz { all, levels, gen_bg, cull_bg }
}

/// Recursos de post-proceso que no dependen del tamano.
struct PostRes {
    layout: wgpu::BindGroupLayout,
    pu: wgpu::Buffer,
    samp: wgpu::Sampler,
    dummy: wgpu::TextureView,
    ao_pl: wgpu::RenderPipeline,
    down0_pl: wgpu::RenderPipeline,
    down_pl: wgpu::RenderPipeline,
    comp_pl: wgpu::RenderPipeline,
}

fn make_targets(
    device: &wgpu::Device, w: u32, h: u32, depth: &wgpu::TextureView, globals: &wgpu::Buffer, r: &PostRes,
) -> Targets {
    let mk = |fmt, w: u32, h: u32| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: fmt,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&Default::default())
    };
    let hdr = mk(HDR, w, h);
    let ao = mk(wgpu::TextureFormat::R8Unorm, w >> 1, h >> 1);
    let bloom: Vec<_> = (1..=4).map(|k| mk(HDR, w >> k, h >> k)).collect();
    let d = &r.dummy;
    let bg = |a: &wgpu::TextureView, o: &wgpu::TextureView, b: [&wgpu::TextureView; 4]| {
        let tv = |binding, v| wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(v) };
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None, layout: &r.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: globals.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: r.pu.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&r.samp) },
                tv(3, depth), tv(4, a), tv(5, o), tv(6, b[0]), tv(7, b[1]), tv(8, b[2]), tv(9, b[3]),
            ],
        })
    };
    let bg_ao = bg(d, d, [d, d, d, d]);
    let bg_down = vec![
        bg(&hdr, d, [d, d, d, d]), bg(&bloom[0], d, [d, d, d, d]),
        bg(&bloom[1], d, [d, d, d, d]), bg(&bloom[2], d, [d, d, d, d]),
    ];
    let bg_comp = bg(&hdr, &ao, [&bloom[0], &bloom[1], &bloom[2], &bloom[3]]);
    Targets { hdr, ao, bloom, bg_ao, bg_down, bg_comp }
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
    instances: &[f32],
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
                max_storage_buffers_per_shader_stage: max.max_storage_buffers_per_shader_stage.min(10),
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .map_err(err)?;

    device.on_uncaptured_error(std::sync::Arc::new(|e: wgpu::Error| {
        GPU_STATUS.with(|s| s.borrow_mut().1 = e.to_string());
    }));
    device.set_device_lost_callback(|reason, msg| {
        GPU_STATUS.with(|s| *s.borrow_mut() = (true, format!("{reason:?}: {msg}")));
    });
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

    // Instancias: 8 floats cada una [x, y, z, escala, modelo, yaw, hash, 0]; las pone el anfitrion
    // (`instances` ahora y `set_instances` despues). `count` es la capacidad maxima.
    let n0 = ((instances.len() / 8) as u32).min(count);
    let inst_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: count as u64 * 32, mapped_at_creation: false,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
    });
    queue.write_buffer(&inst_buf, 0, bytemuck::cast_slice(&instances[..n0 as usize * 8]));
    let chunks = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: count.div_ceil(64) as u64 * 16 + 16, mapped_at_creation: false,
        usage: wgpu::BufferUsages::STORAGE,
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
    let stage_size = ((nd * 20 + 63) / 64 * 64 + 64) as u64;
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: stage_size, mapped_at_creation: false,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
    });
    let vis = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: count as u64 * 8, mapped_at_creation: false, // hasta 2 copias por instancia (fundido de LOD)
        usage: wgpu::BufferUsages::STORAGE,
    });

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None, source: wgpu::ShaderSource::Wgsl(format!("{}
{}", lux::WGSL, include_str!("shader.wgsl")).into()),
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
            entry(rw, 3, S::COMPUTE), entry(rw, 4, S::COMPUTE), entry(rw, 5, S::COMPUTE), entry(rw, 6, S::COMPUTE), entry(rw, 7, S::COMPUTE),
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
    // Resultado de `pick` por instancia (count lo escribe, scatter lo lee): se evalua una sola vez por vista.
    let work = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: count as u64 * 8, mapped_at_creation: false, usage: wgpu::BufferUsages::STORAGE,
    });
    let cull_bg = bind(&cull_l, &[(0, &globals), (1, &inst_buf), (2, &info_buf), (3, &args), (4, &cur), (5, &vis), (6, &chunks), (7, &work)]);
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
    // Grupo 3: suelo (bindings 0..=2) + iluminacion de lux (bindings 3..=7).
    let lux = Lux::new(&device);
    let mut gl = vec![
        tex_entry(0), tex_entry(1),
        wgpu::BindGroupLayoutEntry {
            binding: 2, visibility: S::FRAGMENT, count: None,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        },
    ];
    gl.extend(Lux::layout_entries());
    let gnd_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &gl });
    let mut ge = vec![
        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&g_base) },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&g_norm) },
        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
    ];
    ge.extend(lux.bind_entries());
    let gnd_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &gnd_l, entries: &ge });
    drop(ge);

    let utex = |binding, vis| wgpu::BindGroupLayoutEntry {
        binding, visibility: vis, count: None,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
        },
    };
    let hiz_cull_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[utex(1, S::COMPUTE)] });
    let cull_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None, bind_group_layouts: &[Some(&cull_l), Some(&hiz_cull_l)], immediate_size: 0,
    });
    let cpl = |entry_point: &str| {
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None, layout: Some(&cull_layout), module: &module,
            entry_point: Some(entry_point), compilation_options: Default::default(), cache: None,
        })
    };
    let (count_pl, scan_pl, scatter_pl) = (cpl("count"), cpl("scan"), cpl("scatter"));
    let chunk_pl = cpl("chunk_build");
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
            targets: &[Some(HDR.into())],
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
            targets: &[Some(HDR.into())],
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
            targets: &[Some(HDR.into())],
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
    let mk_view = |_layer: u32| -> SView {
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
        let cull_bg = bind(&cull_l, &[(0, &globals), (1, &inst_buf), (2, &info_buf), (3, &args), (4, &cur), (5, &svis), (6, &chunks), (7, &work)]);
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
        SView { globals, args, cur, cull_bg, bundle }
    };
    let sviews: Vec<SView> = (0..lux::SHADOW_LAYERS).map(mk_view).collect();

    let ts = device.features().contains(wgpu::Features::TIMESTAMP_QUERY).then(|| Ts {
        qs: device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: 8 }),
        resolve: device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: 64, mapped_at_creation: false,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        }),
        period: queue.get_timestamp_period(),
    });
    let depth = depth_view(&device, w, h);
    // Hi-Z
    let hiz_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None, source: wgpu::ShaderSource::Wgsl(include_str!("hiz.wgsl").into()),
    });
    let hiz_gen_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0, visibility: S::FRAGMENT, count: None,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
                },
            },
            utex(1, S::FRAGMENT),
        ],
    });
    let hpl = |entry: &str| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None, bind_group_layouts: &[Some(&hiz_gen_l)], immediate_size: 0,
            })),
            vertex: wgpu::VertexState {
                module: &hiz_module, entry_point: Some("vs_full"), compilation_options: Default::default(), buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &hiz_module, entry_point: Some(entry), compilation_options: Default::default(),
                targets: &[Some(wgpu::TextureFormat::R32Float.into())],
            }),
            primitive: Default::default(), depth_stencil: None,
            multisample: Default::default(), multiview_mask: None, cache: None,
        })
    };
    let hiz_res = HizRes {
        dummy: device
            .create_texture(&wgpu::TextureDescriptor {
                label: None,
                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R32Float, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
            })
            .create_view(&Default::default()),
        pl0: hpl("fs_hiz0"),
        pln: hpl("fs_hizn"),
        gen_l: hiz_gen_l,
        cull_l: hiz_cull_l,
    };
    let hiz = make_hiz(&device, &queue, w, h, &depth, &hiz_res);
    // Post-proceso: AO en pantalla, bloom (4 reducciones) y composicion con ACES.
    let post_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None, source: wgpu::ShaderSource::Wgsl(include_str!("post.wgsl").into()),
    });
    let pe = |binding, ty| wgpu::BindGroupLayoutEntry { binding, visibility: S::FRAGMENT, count: None, ty };
    let ftex = || wgpu::BindingType::Texture {
        sample_type: wgpu::TextureSampleType::Float { filterable: true },
        view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
    };
    let ubuf = || wgpu::BindingType::Buffer { ty: B::Uniform, has_dynamic_offset: false, min_binding_size: None };
    let post_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            pe(0, ubuf()), pe(1, ubuf()), pe(2, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
            pe(3, wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Depth,
                view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
            }),
            pe(4, ftex()), pe(5, ftex()), pe(6, ftex()), pe(7, ftex()), pe(8, ftex()), pe(9, ftex()),
        ],
    });
    let ppl = |entry: &str, fmt: wgpu::TextureFormat| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None, bind_group_layouts: &[Some(&post_l)], immediate_size: 0,
            })),
            vertex: wgpu::VertexState {
                module: &post_module, entry_point: Some("vs_full"), compilation_options: Default::default(), buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &post_module, entry_point: Some(entry), compilation_options: Default::default(),
                targets: &[Some(fmt.into())],
            }),
            primitive: Default::default(), depth_stencil: None,
            multisample: Default::default(), multiview_mask: None, cache: None,
        })
    };
    let dummy = device
        .create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: HDR,
            usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
        })
        .create_view(&Default::default());
    let post = PostRes {
        pu: device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: 16, mapped_at_creation: false,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        }),
        samp: device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        }),
        ao_pl: ppl("fs_ao", wgpu::TextureFormat::R8Unorm),
        down0_pl: ppl("fs_down0", HDR),
        down_pl: ppl("fs_down", HDR),
        comp_pl: ppl("fs_comp", cfg.format),
        layout: post_l,
        dummy,
    };
    let tg = make_targets(&device, w, h, &depth, &globals, &post);
    let bundle = {
        let mut b = device.create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
            label: None,
            color_formats: &[Some(HDR)],
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
    let parts = Particles::new(&device, HDR, DEPTH, 65536);
    let skin_sys = SkinSys::new(&device, lux::WGSL, &draw_l, &gnd_l, HDR, DEPTH);
    Ok(Phoenix {
        surface, cfg, device, queue, depth, tg, post, post_k: [0.05, 0.8, 0.6], globals, args, cur, staging, count_pl, scan_pl, scatter_pl,
        cull_bg, draw_pl, bundle, cluster_pl, lux, sviews, draw_bg, vis_bg, vbuf, ibuf, args0, zeros: vec![0; nd], n: n0, models, lods,
        frame: 0, tau: 1.0, capacity: count, hiz, hiz_res, prev_vp: Mat4::IDENTITY, hiz_on: true, hiz_ready: false, min_px: 1.0, far_tol: 0.6, env_on: true, inst_buf, chunks, chunk_pl, dirty: true, flat, textured, tex_bg, gnd_bg, ground_pl, sky_pl, busy: Rc::new(Cell::new(false)), stats: Rc::new(Cell::new([0.0; 8])), ts,
        tris: Rc::new(tris), full: Rc::new(full), parts, skin_sys, skins: vec![],
    })
}

#[wasm_bindgen]
impl Phoenix {
    pub fn resize(&mut self, w: u32, h: u32) {
        self.cfg.width = w.max(1);
        self.cfg.height = h.max(1);
        self.surface.configure(&self.device, &self.cfg);
        self.depth = depth_view(&self.device, self.cfg.width, self.cfg.height);
        self.tg = make_targets(&self.device, self.cfg.width, self.cfg.height, &self.depth, &self.globals, &self.post);
        self.hiz = make_hiz(&self.device, &self.queue, self.cfg.width, self.cfg.height, &self.depth, &self.hiz_res);
        self.hiz_ready = false;
    }

    /// [visibles, tris dibujados, tris a resolucion completa, draws no vacios, cull ms, render ms,
    ///  sombras ms, hiz+post ms]
    pub fn stats(&self) -> Vec<f64> {
        self.stats.get().to_vec()
    }

    /// Tolerancia de error del LOD en pixeles (1 = sin diferencia visible).
    pub fn set_tolerance(&mut self, px: f32) {
        self.tau = px;
    }

    /// Luces (16 floats cada una, ver `lux::LIGHT_STRIDE`): puntuales, focos y tubos. Maximo 512.
    /// El culling por clusters y el sombreado ocurren en la GPU; esto solo sube el buffer.
    pub fn set_lights(&mut self, data: &[f32]) {
        self.lux.set_lights(&self.queue, data);
    }

    /// Sol: radiancia (r, g, b) y escala de la luz ambiente.
    pub fn set_sun(&mut self, r: f32, g: f32, b: f32, ambient: f32) {
        self.lux.sun = [r, g, b, ambient];
    }

    /// Direccion del sol: azimut y elevacion en radianes.
    pub fn set_sun_dir(&mut self, az: f32, el: f32) {
        self.lux.set_sun_dir(az, el);
    }

    /// Luna: direccion y color (sin sombras); 0 la apaga.
    pub fn set_moon(&mut self, az: f32, el: f32, r: f32, g: f32, b: f32) {
        self.lux.set_moon(az, el, [r, g, b]);
    }

    /// Exposicion del mapeo de tonos.
    pub fn set_exposure(&mut self, e: f32) {
        self.lux.exposure = e;
    }

    /// Post-proceso: intensidad del bloom, fuerza del AO (0..1) y radio del AO en metros.
    pub fn set_post(&mut self, bloom: f32, ao: f32, radius: f32) {
        self.post_k = [bloom, ao, radius.max(0.05)];
    }

    /// El dispositivo de GPU se perdio (driver reiniciado, pestana en segundo plano prolongada...).
    /// El anfitrion debe recrear el motor.
    pub fn is_lost(&self) -> bool {
        GPU_STATUS.with(|s| s.borrow().0)
    }

    /// Ultimo error de GPU (cadena vacia si no hay) y se borra al leerlo.
    pub fn take_error(&self) -> String {
        GPU_STATUS.with(|s| std::mem::take(&mut s.borrow_mut().1))
    }

    /// Diametro minimo (px) para dibujar una instancia; por debajo se descarta (1 = sin diferencia visible).
    pub fn set_min_pixels(&mut self, px: f32) {
        self.min_px = px.max(0.0);
    }

    /// Aumento de la tolerancia del LOD con la distancia (0 = tolerancia constante); a 500 m o mas
    /// la tolerancia es `tau * (1 + k)`.
    pub fn set_far_tolerance(&mut self, k: f32) {
        self.far_tol = k.max(0.0);
    }

    /// Dibuja (o no) el cielo y el suelo de entorno; desactivalo en interiores.
    pub fn set_environment(&mut self, on: bool) {
        self.env_on = on;
    }

    /// Ambiente plano (interiores): sustituye al ambiente por hora del dia. `scale` = 0 lo desactiva.
    pub fn set_flat_ambient(&mut self, r: f32, g: f32, b: f32, scale: f32) {
        self.lux.flat_ambient = if scale > 0.0 { Some([r * scale, g * scale, b * scale]) } else { None };
    }

    /// Culling por oclusion con la piramide Hi-Z del frame anterior.
    pub fn set_occlusion(&mut self, on: bool) {
        self.hiz_on = on;
    }

    /// Activa o desactiva las sombras del sol (2 cascadas).
    pub fn set_shadows(&mut self, on: bool) {
        self.lux.shadows = on;
    }

    /// Escribe instancias a partir de la posicion `first` (8 floats cada una:
    /// x, y, z, escala, modelo, yaw, hash, 0). Amplia el contador si hace falta.
    pub fn set_instances(&mut self, first: u32, data: &[f32]) {
        let n = (data.len() / 8) as u32;
        let n = n.min(self.capacity.saturating_sub(first));
        self.queue.write_buffer(&self.inst_buf, first as u64 * 32, bytemuck::cast_slice(&data[..n as usize * 8]));
        self.n = self.n.max(first + n);
        self.dirty = true;
    }

    /// Numero de instancias activas (0..=capacidad).
    pub fn set_count(&mut self, n: u32) {
        self.n = n.min(self.capacity);
        self.dirty = true;
    }

    pub fn count(&self) -> u32 {
        self.n
    }

    /// Anade un personaje con huesos (paquete de `phoenix-bake --kind skin`); devuelve su indice.
    /// `clips`: 4 floats por clip `[primer fotograma, fotogramas, fps, duracion]`.
    #[allow(clippy::too_many_arguments)]
    pub fn add_skin(&mut self, verts: &[u8], idx: &[u8], mats: &[u8], clips: &[f32], bones: u32, tex_size: u32, tex_mips: u32, tex: &[u8]) -> u32 {
        let m = self.skin_sys.add(&self.device, &self.queue, verts, idx, mats, clips, bones, tex_size, tex_mips, tex);
        self.skins.push(m);
        self.skins.len() as u32 - 1
    }

    /// Instancias de un personaje: 8 floats `[x, y, z, escala, yaw, clip, tiempo en s, 0]` cada una.
    pub fn set_skin_instances(&mut self, model: u32, data: &[f32]) {
        if let Some(m) = self.skins.get_mut(model as usize) {
            m.set(&self.queue, data);
        }
    }

    /// Emite `count` particulas (formato de `p` en `Particles::emit`: 17 floats).
    pub fn emit_particles(&mut self, p: &[f32], count: u32) {
        let now = web_sys::window().and_then(|w| w.performance()).map(|p| p.now() as f32 / 1000.0).unwrap_or(0.0);
        self.parts.emit(&self.queue, now, p, count);
    }

    pub fn frame(&mut self, ex: f32, ey: f32, ez: f32, yaw: f32, pitch: f32) {
        let eye = Vec3::new(ex, ey, ez);
        let dir = Vec3::new(yaw.sin() * pitch.cos(), pitch.sin(), -yaw.cos() * pitch.cos());
        let aspect = self.cfg.width as f32 / self.cfg.height as f32;
        let vp = Mat4::perspective_rh(FOV, aspect, 0.3, 4000.0) * Mat4::look_to_rh(eye, dir, Vec3::Y);
        let planes = lux::planes_of(vp);
        {
            let right = dir.cross(Vec3::Y).normalize_or_zero();
            let up = right.cross(dir);
            let now = web_sys::window().and_then(|w| w.performance()).map(|p| p.now() as f32 / 1000.0).unwrap_or(0.0);
            let u = particles::PU { vp: vp.to_cols_array(), right: [right.x, right.y, right.z, 0.0], up: [up.x, up.y, up.z, 0.0], time: [now, 0.0, 0.0, 0.0] };
            self.queue.write_buffer(&self.parts.uni, 0, bytemuck::bytes_of(&u));
        }
        let g = Globals {
            view_proj: vp.to_cols_array(),
            cam: [ex, ey, ez, self.cfg.height as f32 / (2.0 * (FOV * 0.5).tan())],
            planes,
            misc: [self.n as f32, self.models as f32, self.lods as f32, self.tau],
            light: if self.flat {
                let l = self.lux.sun_dir;
                [l.x, l.y, l.z, if self.textured { 2.0 } else { 1.0 }]
            } else {
                [0.5, 0.8, 0.3, 0.0]
            },
            inv_vp: vp.inverse().to_cols_array(),
            grid: [self.cfg.width as f32, self.cfg.height as f32, 0.3, 150.0],
            prev_vp: self.prev_vp.to_cols_array(),
            vw: [0.0, if self.hiz_on && self.hiz_ready { 1.0 } else { 0.0 }, 0.0, self.lux.n_lights as f32],
            tune: [self.min_px, self.far_tol, 0.0, 0.0],
        };
        // Cascadas de sombras del sol (las calcula lux; phoenix las usa para el culling y el render).
        // Vistas de sombras activas: cascadas del sol (capas 0 y 1) y focos con sombra (capas 2..=5).
        let shadows = self.flat && self.textured && self.lux.shadows_active();
        let mut active: Vec<usize> = vec![];
        let casc = if shadows { Some(self.lux.fit_cascades(eye, dir)) } else { None };
        if let Some(casc) = &casc {
            for (i, c) in casc.iter().enumerate() {
                let mut gc = g;
                gc.view_proj = c.view_proj.to_cols_array();
                gc.planes = lux::planes_of(c.view_proj);
                gc.inv_vp = c.view_proj.inverse().to_cols_array();
                gc.misc[3] = 1.5;
                gc.tune[0] = 1.0;
                gc.vw = [1.0, lux::SHADOW_RES as f32 / (2.0 * c.radius), 1.0, 0.0];
                let sv = &self.sviews[i];
                self.queue.write_buffer(&sv.globals, 0, bytemuck::bytes_of(&gc));
                self.queue.write_buffer(&sv.args, 0, bytemuck::cast_slice(&self.args0));
                self.queue.write_buffer(&sv.cur, 0, bytemuck::cast_slice(&self.zeros));
                active.push(i);
            }
        }
        let spots = if self.textured { self.lux.update_shadow_spots(&self.queue, eye) } else { vec![] };
        for sp in &spots {
            let mut gc = g;
            gc.view_proj = sp.view_proj.to_cols_array();
            gc.planes = lux::planes_of(sp.view_proj);
            gc.inv_vp = sp.view_proj.inverse().to_cols_array();
            gc.cam = [sp.pos.x, sp.pos.y, sp.pos.z, lux::SHADOW_RES as f32 / (2.0 * (sp.fov * 0.5).tan())];
            gc.misc[3] = 1.5;
            gc.tune = [1.0, 0.0, 0.0, 0.0];
            gc.vw = [0.0, 0.0, 1.0, 0.0];
            let k = 2 + sp.slot;
            let sv = &self.sviews[k];
            self.queue.write_buffer(&sv.globals, 0, bytemuck::bytes_of(&gc));
            self.queue.write_buffer(&sv.args, 0, bytemuck::cast_slice(&self.args0));
            self.queue.write_buffer(&sv.cur, 0, bytemuck::cast_slice(&self.zeros));
            active.push(k);
        }
        self.lux.write_uniform(&self.queue, casc.as_ref(), &spots);
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
        let dirty = std::mem::take(&mut self.dirty);
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
            p.set_bind_group(1, &self.hiz.cull_bg, &[]);
            if dirty {
                p.set_pipeline(&self.chunk_pl);
                p.set_bind_group(0, &self.cull_bg, &[]);
                p.dispatch_workgroups(self.n.div_ceil(64).div_ceil(64).max(1), 1, 1);
            }
            let views = std::iter::once(&self.cull_bg).chain(active.iter().map(|&k| &self.sviews[k].cull_bg));
            for bg in views {
                p.set_bind_group(0, bg, &[]);
                for (k, pl) in [&self.count_pl, &self.scan_pl, &self.scatter_pl].into_iter().enumerate() {
                    p.set_pipeline(pl);
                    p.dispatch_workgroups(if k == 1 { 1 } else { groups }, 1, 1);
                }
            }
            if self.lux.n_lights > 0 {
                p.set_pipeline(&self.cluster_pl);
                p.set_bind_group(0, &self.cull_bg, &[]);
                p.set_bind_group(3, &self.gnd_bg, &[]);
                p.dispatch_workgroups(Lux::cluster_groups(), 1, 1);
            }
        }
        if !active.is_empty() {
            for (n, &k) in active.iter().enumerate() {
                let sv = &self.sviews[k];
                let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: None,
                    color_attachments: &[],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: self.lux.layer(k),
                        depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: self.ts.as_ref().filter(|_| n == 0 || n + 1 == active.len()).map(|t| wgpu::RenderPassTimestampWrites {
                        query_set: &t.qs,
                        beginning_of_pass_write_index: if n == 0 { Some(4) } else { None },
                        end_of_pass_write_index: if n + 1 == active.len() { Some(5) } else { None },
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
                    view: &self.tg.hdr, depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.80, g: 0.77, b: 0.71, a: 1.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store,
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
            if self.flat && self.env_on {
                p.set_pipeline(&self.sky_pl);
                p.set_bind_group(0, &self.draw_bg, &[]);
                p.draw(0..3, 0..1);
                p.set_pipeline(&self.ground_pl);
                p.set_bind_group(0, &self.draw_bg, &[]);
                p.set_bind_group(3, &self.gnd_bg, &[]);
                p.draw(0..6, 0..1);
            }
            p.execute_bundles([&self.bundle]);
            for m in &self.skins {
                m.draw(&mut p, &self.skin_sys.pl, &self.draw_bg, &self.gnd_bg);
            }
            if self.parts.live > 0 {
                p.set_pipeline(&self.parts.pl);
                p.set_bind_group(0, &self.parts.bg, &[]);
                p.draw(0..6, 0..self.parts.live);
            }
        }
        // Hi-Z para el culling del frame siguiente.
        for k in 0..self.hiz.levels.len() {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.hiz.levels[k], depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::WHITE), store: wgpu::StoreOp::Store },
                })],
                timestamp_writes: self.ts.as_ref().filter(|_| k == 0).map(|t| wgpu::RenderPassTimestampWrites {
                    query_set: &t.qs, beginning_of_pass_write_index: Some(6), end_of_pass_write_index: None,
                }),
                ..Default::default()
            });
            p.set_pipeline(if k == 0 { &self.hiz_res.pl0 } else { &self.hiz_res.pln });
            p.set_bind_group(0, &self.hiz.gen_bg[k], &[]);
            p.draw(0..3, 0..1);
        }
        self.prev_vp = vp;
        self.hiz_ready = true;
        // Post-proceso: AO -> bloom (4 reducciones) -> composicion en la pantalla.
        self.queue.write_buffer(&self.post.pu, 0, bytemuck::cast_slice(&[self.lux.exposure, self.post_k[0], self.post_k[1], self.post_k[2]]));
        {
            let ts = &self.ts;
            let pass = |enc: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, pl: &wgpu::RenderPipeline, bg: &wgpu::BindGroup, last: bool| {
                let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: None,
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: target, depth_slice: None, resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                    })],
                    timestamp_writes: ts.as_ref().filter(|_| last).map(|t| wgpu::RenderPassTimestampWrites {
                        query_set: &t.qs, beginning_of_pass_write_index: None, end_of_pass_write_index: Some(7),
                    }),
                    ..Default::default()
                });
                p.set_pipeline(pl);
                p.set_bind_group(0, bg, &[]);
                p.draw(0..3, 0..1);
            };
            let (t, r) = (&self.tg, &self.post);
            pass(&mut enc, &t.ao, &r.ao_pl, &t.bg_ao, false);
            for k in 0..4 {
                pass(&mut enc, &t.bloom[k], if k == 0 { &r.down0_pl } else { &r.down_pl }, &t.bg_down[k], false);
            }
            pass(&mut enc, &view, &r.comp_pl, &t.bg_comp, true);
        }
        let read = self.frame % 45 == 0 && !self.busy.get();
        let nd = (self.models * self.lods) as usize;
        let ts_off = ((nd * 20 + 63) / 64 * 64) as u64;
        if read {
            enc.copy_buffer_to_buffer(&self.args, 0, &self.staging, 0, (nd * 20) as u64);
            if let Some(t) = &self.ts {
                enc.resolve_query_set(&t.qs, 0..8, &t.resolve, 0);
                enc.copy_buffer_to_buffer(&t.resolve, 0, &self.staging, ts_off, 64);
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
                        let t: &[u64] = bytemuck::cast_slice(&d[ts_off as usize..ts_off as usize + 64]);
                        let ms = |a: u64, b: u64| b.saturating_sub(a) as f64 * p as f64 * 1e-6;
                        s[4] = ms(t[0], t[1]);
                        s[5] = ms(t[2], t[3]);
                        s[6] = ms(t[4], t[5]);
                        s[7] = ms(t[6], t[7]);
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
