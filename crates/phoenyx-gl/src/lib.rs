// phoenyx-gl: renderer WebGPU que dibuja lo que le manda el paquete TypeScript `phoenyx` (la API de three).
// Recibe arrays tipados por fotograma (globales, objetos, materiales, luces, lista de dibujos ya ordenada) y los pinta
// con el sombreado portado de three 0.160.1 (ver shader.wgsl). Los formatos de los arrays estan en docs/FASE1.md.
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// Floats por entrada de cada array de entrada (deben coincidir con shader.wgsl y con pack.ts).
pub const GLOBALS_F: usize = 64;

/// Estado de un dispositivo: (perdido, ultimo error). Uno por `Gl`: el renderer principal convive con los de iconos y avatares.
type Status = std::sync::Arc<std::sync::Mutex<(bool, String)>>;

fn entry(b: u32, buf: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding: b, resource: buf.as_entire_binding() }
}


/// Textura Rgba32Float cuadrada (tablas LTC de RectAreaLight); se lee con textureLoad.
/// Textura RGBA8 (sin sRGB) de `w` x `h` para un lightmap.
/// Aplica el viewport y el scissor (ya recortados) a una pasada.
fn apply_rects(p: &mut wgpu::RenderPass<'_>, rects: (Option<[u32; 4]>, Option<[u32; 4]>)) {
    if let Some(v) = rects.0 {
        p.set_viewport(v[0] as f32, v[1] as f32, v[2] as f32, v[3] as f32, 0.0, 1.0);
    }
    if let Some(s) = rects.1 {
        p.set_scissor_rect(s[0], s[1], s[2], s[3]);
    }
}

fn rgba8_view(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, data: &[u8]) -> wgpu::TextureView {
    let t = device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        data,
    );
    t.create_view(&Default::default())
}

fn ltc_view(device: &wgpu::Device, queue: &wgpu::Queue, n: u32, data: &[f32]) -> wgpu::TextureView {
    let t = device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: n, height: n, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        bytemuck::cast_slice(data),
    );
    t.create_view(&Default::default())
}

/// Mapas de sombra: una textura de profundidad con una capa por luz; devuelve la vista del array y una vista por capa.
fn shadow_views(device: &wgpu::Device, layers: u32, size: u32) -> (wgpu::TextureView, Vec<wgpu::TextureView>) {
    let t = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: layers },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: DEPTH,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let all = t.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    let each = (0..layers)
        .map(|l| t.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2), base_array_layer: l, array_layer_count: Some(1), ..Default::default() }))
        .collect();
    (all, each)
}

fn srgb_to_lin(v: u8) -> f32 {
    let c = v as f32 / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn lin_to_srgb(x: f32) -> u8 {
    let c = x.clamp(0.0, 1.0);
    let s = if c <= 0.0031308 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0 + 0.5) as u8
}

/// Siguiente nivel de mipmap: caja 2x2 (en espacio lineal si la textura es sRGB; el alfa siempre lineal).
fn downsample(src: &[u8], w: u32, h: u32, srgb: bool, lut: &[f32; 256]) -> (Vec<u8>, u32, u32) {
    let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        for x in 0..nw {
            let (x0, x1) = ((x * 2).min(w - 1), (x * 2 + 1).min(w - 1));
            let (y0, y1) = ((y * 2).min(h - 1), (y * 2 + 1).min(h - 1));
            let px = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)];
            for c in 0..4 {
                let mut acc = 0.0f32;
                for &(px_x, px_y) in &px {
                    let v = src[((px_y * w + px_x) * 4 + c) as usize];
                    acc += if srgb && c < 3 { lut[v as usize] } else { v as f32 / 255.0 };
                }
                let m = acc * 0.25;
                out[((y * nw + x) * 4 + c) as usize] = if srgb && c < 3 { lin_to_srgb(m) } else { (m * 255.0 + 0.5) as u8 };
            }
        }
    }
    (out, nw, nh)
}

fn err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

struct Slot {
    offset: u32,
    cap: u32,
    n: u32,
}

/// Render target: color (RGBA16F o RGBA8) y profundidad propios; el color tambien se registra como textura para leerlo.
struct Target {
    view: wgpu::TextureView,
    depth: wgpu::TextureView,
    fmt: u32,
    w: u32,
    h: u32,
    color_id: u32,
    depth_id: u32,
}

/// Limpieza pedida con `clear()` para el proximo dibujo sobre ese destino.
#[derive(Default, Clone, Copy)]
struct Pending {
    color: Option<[f64; 4]>,
    depth: bool,
}

/// Formato de color segun el codigo de destino: 0 pantalla, 1 RGBA16F, 2 RGBA8.
fn target_format(fmt: u32, screen: wgpu::TextureFormat) -> wgpu::TextureFormat {
    match fmt {
        1 => wgpu::TextureFormat::Rgba16Float,
        2 => wgpu::TextureFormat::Rgba8Unorm,
        _ => screen,
    }
}

/// Pipeline de un pase: shader (entrada `fs_*`), mezcla y formato de destino.
struct PassPl {
    pl: wgpu::RenderPipeline,
}

/// three -> wgpu: factores y ecuaciones de mezcla (constantes de three: 200 Zero ... 210 SrcAlphaSaturate; 100 Add ... 104 Max)
fn blend_factor(f: u32) -> wgpu::BlendFactor {
    match f {
        200 => wgpu::BlendFactor::Zero,
        201 => wgpu::BlendFactor::One,
        202 => wgpu::BlendFactor::Src,
        203 => wgpu::BlendFactor::OneMinusSrc,
        204 => wgpu::BlendFactor::SrcAlpha,
        205 => wgpu::BlendFactor::OneMinusSrcAlpha,
        206 => wgpu::BlendFactor::DstAlpha,
        207 => wgpu::BlendFactor::OneMinusDstAlpha,
        208 => wgpu::BlendFactor::Dst,
        209 => wgpu::BlendFactor::OneMinusDst,
        210 => wgpu::BlendFactor::SrcAlphaSaturated,
        _ => wgpu::BlendFactor::One,
    }
}

fn blend_op(e: u32) -> wgpu::BlendOperation {
    match e {
        101 => wgpu::BlendOperation::Subtract,
        102 => wgpu::BlendOperation::ReverseSubtract,
        103 => wgpu::BlendOperation::Min,
        104 => wgpu::BlendOperation::Max,
        _ => wgpu::BlendOperation::Add,
    }
}

/// WGSL de cada shader de usuario (cuerpo; la cabecera comun se antepone). Los ids los define packages/phoenyx/src/user-shaders.
/// Devuelve (cuerpo WGSL, true si es un shader de Points: vertices leidos del buffer de la geometria, un cuadrado por punto).
fn user_src(id: u32) -> Option<(String, bool)> {
    Some(match id {
        0 => (include_str!("user/prueba.wgsl").to_string(), false),
        1 => (include_str!("user/waterjet.wgsl").to_string(), true),
        // niebla volumetrica del parking: 4 pasos (calidad baja) o 10
        2 => (include_str!("user/parking_fog.wgsl").replace("@N@", "4"), false),
        3 => (include_str!("user/parking_fog.wgsl").replace("@N@", "10"), false),
        4 => (include_str!("user/parking_shaft.wgsl").to_string(), false),
        5 => (include_str!("user/remote_beam.wgsl").to_string(), false),
        6 => (include_str!("user/vents_gas.wgsl").to_string(), true),
        7 => (include_str!("user/dust_cam.wgsl").to_string(), true),
        8 => (include_str!("user/dust_world.wgsl").to_string(), true),
        9 => (include_str!("user/world_shaft.wgsl").to_string(), false),
        10 => (include_str!("user/world_sky.wgsl").to_string(), false),
        // PointsMaterial de three (integrado)
        20 => (include_str!("user/points_basic.wgsl").to_string(), true),
        // SpriteMaterial de three (integrado)
        21 => (include_str!("user/sprite_basic.wgsl").to_string(), false),
        // LineBasicMaterial de three (integrado)
        22 => (include_str!("user/line_basic.wgsl").to_string(), false),
        // agua de pool.ts (PoolWater, con el reflejo del Reflector en t0)
        30 => (include_str!("user/pool_water.wgsl").to_string(), false),
        // agua del mapa de las Poolrooms (poolmap.ts)
        31 => (include_str!("user/pool_map_water.wgsl").to_string(), false),
        // reflejo bajo la alfombra de world.ts y charcos del parking (Reflector)
        32 => (include_str!("user/world_carpet.wgsl").to_string(), false),
        33 => (include_str!("user/parking_puddles.wgsl").to_string(), false),
        _ => return None,
    })
}

struct Geom {
    vb: wgpu::Buffer,
    ib: wgpu::Buffer,
    n: u32,
    /// vertices (los Points de un shader de usuario leen el buffer de vertices como almacenamiento)
    nv: u32,
}

/// Buffer de almacenamiento que crece cuando hace falta (y avisa para rehacer el bind group).
struct Growable {
    buf: wgpu::Buffer,
    cap: u64,
}

impl Growable {
    fn new(device: &wgpu::Device, cap: u64) -> Self {
        Self { buf: Self::make(device, cap), cap }
    }
    fn make(device: &wgpu::Device, cap: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: cap,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    }
    /// Escribe y devuelve true si hubo que recrearlo.
    fn write(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, data: &[u8]) -> bool {
        let need = (data.len() as u64).max(16);
        let grew = need > self.cap;
        if grew {
            self.cap = need.next_power_of_two();
            self.buf = Self::make(device, self.cap);
        }
        if !data.is_empty() {
            queue.write_buffer(&self.buf, 0, data);
        }
        grew
    }
}

#[wasm_bindgen]
pub struct Gl {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    cfg: wgpu::SurfaceConfiguration,
    depth: wgpu::TextureView,
    module: wgpu::ShaderModule,
    layout: wgpu::PipelineLayout,
    bgl: wgpu::BindGroupLayout,
    tex_bgl: wgpu::BindGroupLayout,
    textures: HashMap<u32, wgpu::TextureView>,
    samplers: HashMap<u32, wgpu::Sampler>,
    bg_desc: HashMap<u32, ([u32; 5], [u32; 5])>,
    bgs: HashMap<u32, wgpu::BindGroup>,
    white: wgpu::TextureView,
    ltc1: wgpu::TextureView,
    ltc2: wgpu::TextureView,
    lm0: wgpu::TextureView,
    lm1: wgpu::TextureView,
    lm_smp: wgpu::Sampler,
    /// entorno PMREM (scene.environment): vista negra por defecto, id del render target que lo contiene (u32::MAX = ninguno)
    env: wgpu::TextureView,
    env_id: u32,
    /// viewport y scissor del destino actual (x, y, ancho, alto en filas de memoria del destino); 0 = todo el destino
    vp: [u32; 4],
    sc: [u32; 4],
    shadows: Growable,
    shadow_all: wgpu::TextureView,
    shadow_layers: Vec<wgpu::TextureView>,
    shadow_dummy: wgpu::TextureView,
    bg_shadow: Option<wgpu::BindGroup>,
    shadow_pipelines: HashMap<u32, wgpu::RenderPipeline>,
    default_sampler: wgpu::Sampler,
    lut: Box<[f32; 256]>,
    globals: wgpu::Buffer,
    objects: Growable,
    materials: Growable,
    lights: Growable,
    draws: Growable,
    inst_mats: Growable,
    inst_cols: Growable,
    slots: HashMap<u32, Slot>,
    inst_next: u32,
    /// plazas de la reserva liberadas (offset, cap) que no eran las ultimas: se reutilizan con la misma capacidad
    free: Vec<(u32, u32)>,
    bg: Option<wgpu::BindGroup>,
    pipelines: HashMap<u32, wgpu::RenderPipeline>,
    geoms: HashMap<u32, Geom>,
    clear: [f64; 4],
    stats: [f32; 3],
    targets: HashMap<u32, Target>,
    cur: u32,
    pending: HashMap<u32, Pending>,
    post_module: wgpu::ShaderModule,
    post_layout: wgpu::PipelineLayout,
    post_bgl: wgpu::BindGroupLayout,
    post_uniforms: wgpu::Buffer,
    /// pases de pantalla completa grabados y aun sin enviar (un solo encoder y un solo submit por tanda)
    post_enc: Option<wgpu::CommandEncoder>,
    status: Status,
    post_n: u32,
    post_frame: Option<wgpu::SurfaceTexture>,
    post_pls: HashMap<(u32, [u32; 7], u32), PassPl>,
    /// shaders de usuario (ShaderMaterial portados): modulo por id y pipeline por (id, banderas, formato, mezcla)
    user_modules: HashMap<u32, wgpu::ShaderModule>,
    user_pls: HashMap<(u32, u32, u32, u32, u32), wgpu::RenderPipeline>,
    /// Points de shaders de usuario: layout con un tercer grupo (vertices como almacenamiento) y un bind group por geometria
    layout_pts: wgpu::PipelineLayout,
    geom_bgl: wgpu::BindGroupLayout,
    geom_bgs: HashMap<u32, wgpu::BindGroup>,
    samp_linear: wgpu::Sampler,
    samp_nearest: wgpu::Sampler,
}

fn depth_view(device: &wgpu::Device, w: u32, h: u32) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
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

#[wasm_bindgen]
pub async fn create(canvas: web_sys::HtmlCanvasElement) -> Result<Gl, JsValue> {
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
    let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor::default()).await.map_err(err)?;
    let status: Status = Default::default();
    let st_err = status.clone();
    device.on_uncaptured_error(std::sync::Arc::new(move |e: wgpu::Error| {
        st_err.lock().unwrap().1 = e.to_string();
    }));
    let st_lost = status.clone();
    device.set_device_lost_callback(move |reason, msg| {
        *st_lost.lock().unwrap() = (true, format!("{reason:?}: {msg}"));
    });

    // Formato sin conversion sRGB: la codificacion de salida la hace el shader, como three en WebGL.
    let mut cfg = surface.get_default_config(&adapter, w, h).ok_or("superficie sin configuracion")?;
    let caps = surface.get_capabilities(&adapter);
    if let Some(f) = caps.formats.iter().copied().find(|f| !f.is_srgb()) {
        cfg.format = f;
    }
    cfg.present_mode = wgpu::PresentMode::AutoVsync;
    surface.configure(&device, &cfg);

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("phoenyx"),
        source: wgpu::ShaderSource::Wgsl(format!("{}\n{}", include_str!("cube_uv.wgsl"), include_str!("shader.wgsl")).into()),
    });
    let st = |b: u32, ty: wgpu::BufferBindingType, vis: wgpu::ShaderStages| wgpu::BindGroupLayoutEntry {
        binding: b,
        visibility: vis,
        count: None,
        ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
    };
    let ro = wgpu::BufferBindingType::Storage { read_only: true };
    let both = wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT;
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            st(0, wgpu::BufferBindingType::Uniform, both),
            st(1, ro, both),
            st(2, ro, both),
            st(3, ro, both),
            st(4, ro, both),
            st(5, ro, both),
            st(6, ro, both),
            wgpu::BindGroupLayoutEntry {
                binding: 7,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            },
            wgpu::BindGroupLayoutEntry {
                binding: 8,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            },
            st(9, ro, both),
            wgpu::BindGroupLayoutEntry {
                binding: 11,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            },
            wgpu::BindGroupLayoutEntry {
                binding: 12,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            },
            wgpu::BindGroupLayoutEntry {
                binding: 13,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            },
            wgpu::BindGroupLayoutEntry {
                binding: 14,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            },
            wgpu::BindGroupLayoutEntry {
                binding: 10,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false },
            },
        ],
    });
    let tex_entry = |b: u32| wgpu::BindGroupLayoutEntry {
        binding: b,
        visibility: wgpu::ShaderStages::FRAGMENT,
        count: None,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
    };
    let samp_entry = |b: u32| wgpu::BindGroupLayoutEntry {
        binding: b,
        visibility: wgpu::ShaderStages::FRAGMENT,
        count: None,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
    };
    let tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[tex_entry(0), tex_entry(1), tex_entry(2), tex_entry(3), tex_entry(4), samp_entry(5), samp_entry(6), samp_entry(7), samp_entry(8), samp_entry(9)],
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[Some(&bgl), Some(&tex_bgl)],
        immediate_size: 0,
    });
    let geom_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX,
            count: None,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
        }],
    });
    let layout_pts = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[Some(&bgl), Some(&tex_bgl), Some(&geom_bgl)],
        immediate_size: 0,
    });
    let globals = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (GLOBALS_F * 4) as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let white_tex = device.create_texture_with_data(
        &queue,
        &wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        &[255, 255, 255, 255],
    );
    let white = white_tex.create_view(&Default::default());
    let default_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    let mut lut = Box::new([0f32; 256]);
    for (i, v) in lut.iter_mut().enumerate() {
        *v = srgb_to_lin(i as u8);
    }
    // pases de pantalla completa: uniformes (64 vec4), 4 texturas filtrables, una sin filtrado (profundidad) y dos muestreadores
    let post_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("phoenyx-post"),
        source: wgpu::ShaderSource::Wgsl(format!("{}\n{}", include_str!("cube_uv.wgsl"), include_str!("post.wgsl")).into()),
    });
    let ptex = |b: u32, filterable: bool| wgpu::BindGroupLayoutEntry {
        binding: b,
        visibility: wgpu::ShaderStages::FRAGMENT,
        count: None,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
    };
    let psamp = |b: u32| wgpu::BindGroupLayoutEntry {
        binding: b,
        visibility: wgpu::ShaderStages::FRAGMENT,
        count: None,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
    };
    let post_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            },
            ptex(1, true),
            ptex(2, true),
            ptex(3, true),
            ptex(4, true),
            ptex(5, true),
            ptex(6, false),
            psamp(7),
            psamp(8),
        ],
    });
    let post_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&post_bgl)], immediate_size: 0 });
    let post_uniforms = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (POST_STRIDE * POST_MAX) as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let samp_linear = device.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    let samp_nearest = device.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        ..Default::default()
    });
    Ok(Gl {
        tex_bgl,
        textures: HashMap::new(),
        samplers: HashMap::new(),
        bg_desc: HashMap::new(),
        bgs: HashMap::new(),
        white,
        ltc1: ltc_view(&device, &queue, 1, &[0.0; 4]),
        ltc2: ltc_view(&device, &queue, 1, &[0.0; 4]),
        lm0: rgba8_view(&device, &queue, 1, 1, &[0; 4]),
        lm1: rgba8_view(&device, &queue, 1, 1, &[0; 4]),
        env: device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba16Float, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] }).create_view(&Default::default()),
        env_id: u32::MAX,
        vp: [0; 4],
        sc: [0; 4],
        lm_smp: device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        }),
        shadows: Growable::new(&device, 1024),
        shadow_all: shadow_views(&device, 1, 1).0,
        shadow_layers: Vec::new(),
        shadow_dummy: shadow_views(&device, 1, 1).0,
        bg_shadow: None,
        shadow_pipelines: HashMap::new(),
        default_sampler,
        lut,
        depth: depth_view(&device, w, h),
        objects: Growable::new(&device, 4096),
        materials: Growable::new(&device, 1024),
        lights: Growable::new(&device, 1024),
        draws: Growable::new(&device, 1024),
        inst_mats: Growable::new(&device, 4096),
        inst_cols: Growable::new(&device, 1024),
        slots: HashMap::new(),
        inst_next: 0,
        free: Vec::new(),
        device,
        queue,
        surface,
        cfg,
        module,
        layout,
        bgl,
        globals,
        bg: None,
        pipelines: HashMap::new(),
        geoms: HashMap::new(),
        clear: [0.0, 0.0, 0.0, 1.0],
        stats: [0.0; 3],
        targets: HashMap::new(),
        cur: u32::MAX,
        pending: HashMap::new(),
        post_module,
        post_layout,
        post_bgl,
        post_uniforms,
        post_enc: None,
        status,
        post_n: 0,
        post_frame: None,
        post_pls: HashMap::new(),
        user_modules: HashMap::new(),
        user_pls: HashMap::new(),
        layout_pts,
        geom_bgl,
        geom_bgs: HashMap::new(),
        samp_linear,
        samp_nearest,
    })
}

/// Bytes por pase en el buffer de uniformes de los pases (multiplo de 256, el alineado de los uniformes) y pases por tanda.
const POST_STRIDE: u32 = 1024;
const POST_MAX: u32 = 128;

#[wasm_bindgen]
impl Gl {
    /// Envia a la GPU los pases de pantalla completa grabados (un solo submit). Lo llaman solos frame(), resize() y los
    /// cambios de render targets; el renderer lo programa ademas al final de la tarea para que lo grabado llegue a pantalla.
    pub fn flush(&mut self) {
        if let Some(enc) = self.post_enc.take() {
            self.queue.submit([enc.finish()]);
        }
        self.post_n = 0;
        self.post_frame = None;
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        let (w, h) = (w.max(1), h.max(1));
        if (w, h) == (self.cfg.width, self.cfg.height) {
            return;
        }
        self.flush();
        self.cfg.width = w;
        self.cfg.height = h;
        self.surface.configure(&self.device, &self.cfg);
        self.depth = depth_view(&self.device, w, h);
    }

    /// Crea (o reemplaza) un render target. `color_id` es su id de textura (para leerlo como `map` o entrada de un pase);
    /// `depth_id` != 0 registra tambien su profundidad como textura legible. `fmt`: 1 RGBA16F, 2 RGBA8.
    pub fn create_target(&mut self, color_id: u32, w: u32, h: u32, fmt: u32, depth_id: u32) {
        self.flush();
        let (w, h) = (w.max(1), h.max(1));
        let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
        let color = self.device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: target_format(fmt, self.cfg.format),
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let depth = self.device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = color.create_view(&Default::default());
        let dview = depth.create_view(&Default::default());
        self.textures.insert(color_id, view.clone());
        if depth_id != 0 {
            self.textures.insert(depth_id, dview.clone());
        }
        self.bgs.clear();
        self.bg = None;
        self.bg_shadow = None;
        self.targets.insert(color_id, Target { view, depth: dview, fmt, w, h, color_id, depth_id });
        // como un framebuffer de GL: la profundidad nueva vale 1 hasta que se limpie
        self.pending.insert(color_id, Pending { color: None, depth: true });
    }

    pub fn drop_target(&mut self, color_id: u32) {
        self.flush();
        if let Some(t) = self.targets.remove(&color_id) {
            self.textures.remove(&t.color_id);
            if t.depth_id != 0 {
                self.textures.remove(&t.depth_id);
            }
            self.bgs.clear();
            self.bg = None;
            self.bg_shadow = None;
        }
        self.pending.remove(&color_id);
        if self.cur == color_id {
            self.cur = u32::MAX;
        }
    }

    /// Destino de los siguientes dibujos: el id de un render target o u32::MAX para la pantalla.
    pub fn set_target(&mut self, id: u32) {
        self.cur = if self.targets.contains_key(&id) { id } else { u32::MAX };
    }

    /// Viewport y scissor del destino actual, como los de un WebGLRenderTarget (origen abajo a la izquierda = fila 0 de la memoria del destino).
    /// `vw == 0` quita el viewport (todo el destino); `sw == 0` quita el scissor.
    pub fn set_viewport(&mut self, vx: u32, vy: u32, vw: u32, vh: u32, sx: u32, sy: u32, sw: u32, sh: u32) {
        self.vp = [vx, vy, vw, vh];
        self.sc = [sx, sy, sw, sh];
    }

    /// Entorno de la escena (scene.environment): id de un render target PMREM (formato CubeUV) o u32::MAX para ninguno.
    pub fn set_environment(&mut self, id: u32) {
        if id != self.env_id {
            self.env_id = id;
            self.bg = None;
            self.bg_shadow = None;
        }
    }

    /// `WebGLRenderer.clear`: el siguiente dibujo sobre el destino actual limpia color y/o profundidad.
    pub fn clear(&mut self, r: f64, g: f64, b: f64, a: f64, color: bool, depth: bool) {
        let p = self.pending.entry(self.cur).or_default();
        if color {
            p.color = Some([r, g, b, a]);
        }
        p.depth |= depth;
    }

    /// Crea o reemplaza una geometria: posiciones y normales de 3 floats, uvs de 2 (puede venir vacio) e indices u32.
    pub fn set_geometry(&mut self, id: u32, positions: &[f32], normals: &[f32], uvs: &[f32], colors: &[f32], indices: &[u32], skin_idx: &[u32], skin_w: &[f32]) {
        let n = positions.len() / 3;
        // por vertice: pos(3) nor(3) uv(2) color(3) f32, indices de hueso 4 x u16 y pesos 4 x f32 = 68 bytes (sin piel: ceros)
        let mut v: Vec<f32> = Vec::with_capacity(n * 17);
        for i in 0..n {
            v.extend_from_slice(&positions[i * 3..i * 3 + 3]);
            if normals.len() >= (i + 1) * 3 {
                v.extend_from_slice(&normals[i * 3..i * 3 + 3]);
            } else {
                v.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            if uvs.len() >= (i + 1) * 2 {
                v.extend_from_slice(&uvs[i * 2..i * 2 + 2]);
            } else {
                v.extend_from_slice(&[0.0, 0.0]);
            }
            if colors.len() >= (i + 1) * 3 {
                v.extend_from_slice(&colors[i * 3..i * 3 + 3]);
            } else {
                v.extend_from_slice(&[1.0, 1.0, 1.0]);
            }
            if skin_idx.len() >= (i + 1) * 4 && skin_w.len() >= (i + 1) * 4 {
                let k = &skin_idx[i * 4..i * 4 + 4];
                v.push(f32::from_bits((k[0] & 0xFFFF) | (k[1] & 0xFFFF) << 16));
                v.push(f32::from_bits((k[2] & 0xFFFF) | (k[3] & 0xFFFF) << 16));
                v.extend_from_slice(&skin_w[i * 4..i * 4 + 4]);
            } else {
                v.extend_from_slice(&[0.0; 6]);
            }
        }
        let vb = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(&v),
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::STORAGE,
        });
        let ib = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(indices),
            usage: wgpu::BufferUsages::INDEX,
        });
        self.geoms.insert(id, Geom { vb, ib, n: indices.len() as u32, nv: n as u32 });
        self.geom_bgs.remove(&id);
    }

    /// Sube una textura RGBA de 8 bits (filas ya en el orden de `flipY`) y calcula sus mipmaps si `mips`.
    pub fn set_texture(&mut self, id: u32, w: u32, h: u32, rgba: &[u8], srgb: bool, mips: bool) {
        if w == 0 || h == 0 || rgba.len() < (w * h * 4) as usize {
            return;
        }
        let levels = if mips { 32 - w.max(h).leading_zeros() } else { 1 };
        let tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: if srgb { wgpu::TextureFormat::Rgba8UnormSrgb } else { wgpu::TextureFormat::Rgba8Unorm },
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut data = rgba[..(w * h * 4) as usize].to_vec();
        let (mut cw, mut ch) = (w, h);
        for lvl in 0..levels {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: lvl, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                &data,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(cw * 4), rows_per_image: Some(ch) },
                wgpu::Extent3d { width: cw, height: ch, depth_or_array_layers: 1 },
            );
            if lvl + 1 < levels {
                let (d, nw, nh) = downsample(&data, cw, ch, srgb, &self.lut);
                data = d;
                cw = nw;
                ch = nh;
            }
        }
        self.textures.insert(id, tex.create_view(&Default::default()));
        self.bgs.clear();
    }

    /// Tablas LTC de RectAreaLight (64x64 RGBA float, las de `RectAreaLightUniformsLib`).
    pub fn set_ltc(&mut self, ltc1: &[f32], ltc2: &[f32]) {
        if ltc1.len() < 64 * 64 * 4 || ltc2.len() < 64 * 64 * 4 {
            return;
        }
        self.ltc1 = ltc_view(&self.device, &self.queue, 64, &ltc1[..64 * 64 * 4]);
        self.ltc2 = ltc_view(&self.device, &self.queue, 64, &ltc2[..64 * 64 * 4]);
        self.bg = None;
    }

    /// Lightmap del juego (parche de lightmap.ts): dos texturas RGBA8 de `w` x `h` (luz + oclusion, y tubos que parpadean).
    pub fn set_lightmap(&mut self, w: u32, h: u32, d0: &[u8], d1: &[u8]) {
        let n = (w * h * 4) as usize;
        if w == 0 || h == 0 || d0.len() < n || d1.len() < n {
            return;
        }
        self.lm0 = rgba8_view(&self.device, &self.queue, w, h, &d0[..n]);
        self.lm1 = rgba8_view(&self.device, &self.queue, w, h, &d1[..n]);
        self.bg = None;
    }

    pub fn drop_texture(&mut self, id: u32) {
        self.textures.remove(&id);
        self.bgs.clear();
    }

    /// `wrap`: 0 repetir, 1 sujetar al borde, 2 espejo. `mip`: 0 sin mipmaps, 1 vecino mas cercano, 2 lineal.
    pub fn set_sampler(&mut self, id: u32, wrap_s: u32, wrap_t: u32, mag_linear: bool, min_linear: bool, mip: u32, anisotropy: u32) {
        let wrap = |w: u32| match w {
            1 => wgpu::AddressMode::ClampToEdge,
            2 => wgpu::AddressMode::MirrorRepeat,
            _ => wgpu::AddressMode::Repeat,
        };
        let f = |l: bool| if l { wgpu::FilterMode::Linear } else { wgpu::FilterMode::Nearest };
        let all_linear = mag_linear && min_linear && mip == 2;
        let samp = self.device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wrap(wrap_s),
            address_mode_v: wrap(wrap_t),
            mag_filter: f(mag_linear),
            min_filter: f(min_linear),
            mipmap_filter: if mip == 2 { wgpu::MipmapFilterMode::Linear } else { wgpu::MipmapFilterMode::Nearest },
            lod_max_clamp: if mip == 0 { 0.0 } else { 32.0 },
            anisotropy_clamp: if all_linear { anisotropy.clamp(1, 16) as u16 } else { 1 },
            ..Default::default()
        });
        self.samplers.insert(id, samp);
        self.bgs.clear();
    }

    /// Define el conjunto de texturas y muestreadores (ids; 0 = ninguno) de una clave de material:
    /// `[map, normalMap, roughnessMap, emissiveMap, bumpMap]`.
    pub fn set_material_textures(&mut self, key: u32, tex: &[u32], samp: &[u32]) {
        if tex.len() < 5 || samp.len() < 5 {
            return;
        }
        self.bg_desc.insert(key, ([tex[0], tex[1], tex[2], tex[3], tex[4]], [samp[0], samp[1], samp[2], samp[3], samp[4]]));
        self.bgs.remove(&key);
    }

    fn ensure_tex_bg(&mut self, key: u32) {
        if self.bgs.contains_key(&key) {
            return;
        }
        let (t, sm) = self.bg_desc.get(&key).copied().unwrap_or(([0; 5], [0; 5]));
        let view = |i: u32| self.textures.get(&i).unwrap_or(&self.white);
        let samp = |i: u32| self.samplers.get(&i).unwrap_or(&self.default_sampler);
        let mut entries: Vec<wgpu::BindGroupEntry> = Vec::with_capacity(10);
        for k in 0..5 {
            entries.push(wgpu::BindGroupEntry { binding: k as u32, resource: wgpu::BindingResource::TextureView(view(t[k])) });
        }
        for k in 0..5 {
            entries.push(wgpu::BindGroupEntry { binding: 5 + k as u32, resource: wgpu::BindingResource::Sampler(samp(sm[k])) });
        }
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.tex_bgl, entries: &entries });
        self.bgs.insert(key, bg);
    }

    /// Sube las matrices (16 floats) y los colores (3 floats, opcionales) de un `InstancedMesh` a la reserva de instancias.
    pub fn set_instances(&mut self, mesh: u32, matrices: &[f32], colors: &[f32]) {
        let n = (matrices.len() / 16) as u32;
        let fits = self.slots.get(&mesh).is_some_and(|s| s.cap >= n);
        if !fits {
            // la plaza vieja se libera; la nueva reutiliza un hueco libre de la misma capacidad o se reserva al final
            self.drop_instances(mesh);
            let cap = n.max(16).next_power_of_two();
            let offset = match self.free.iter().position(|f| f.1 == cap) {
                Some(i) => self.free.swap_remove(i).0,
                None => {
                    let o = self.inst_next;
                    self.inst_next += cap;
                    self.grow_instances(self.inst_next);
                    o
                }
            };
            self.slots.insert(mesh, Slot { offset, cap, n });
        }
        let slot = self.slots.get_mut(&mesh).unwrap();
        slot.n = n;
        let offset = slot.offset;
        self.queue.write_buffer(&self.inst_mats.buf, offset as u64 * 64, bytemuck::cast_slice(&matrices[..(n * 16) as usize]));
        if colors.len() >= (n * 3) as usize {
            let mut padded = Vec::with_capacity(n as usize * 4);
            for c in colors.chunks_exact(3).take(n as usize) {
                padded.extend_from_slice(&[c[0], c[1], c[2], 1.0]);
            }
            self.queue.write_buffer(&self.inst_cols.buf, offset as u64 * 16, bytemuck::cast_slice(&padded));
        }
    }

    pub fn drop_instances(&mut self, mesh: u32) {
        if let Some(old) = self.slots.remove(&mesh) {
            if old.offset + old.cap == self.inst_next {
                self.inst_next = old.offset;
                // si el hueco libre anterior toca el final, tambien se recoge
                while let Some(i) = self.free.iter().position(|f| f.0 + f.1 == self.inst_next) {
                    self.inst_next = self.free.swap_remove(i).0;
                }
            } else {
                self.free.push((old.offset, old.cap));
            }
        }
    }

    /// Hace sitio para `total` instancias en los dos buffers de la reserva, copiando el contenido anterior.
    fn grow_instances(&mut self, total: u32) {
        let need_m = total as u64 * 64;
        let need_c = total as u64 * 16;
        if need_m <= self.inst_mats.cap && need_c <= self.inst_cols.cap {
            return;
        }
        let mut enc = self.device.create_command_encoder(&Default::default());
        if need_m > self.inst_mats.cap {
            let cap = need_m.next_power_of_two();
            let nb = Growable::make(&self.device, cap);
            enc.copy_buffer_to_buffer(&self.inst_mats.buf, 0, &nb, 0, self.inst_mats.cap);
            self.inst_mats = Growable { buf: nb, cap };
        }
        if need_c > self.inst_cols.cap {
            let cap = need_c.next_power_of_two();
            let nb = Growable::make(&self.device, cap);
            enc.copy_buffer_to_buffer(&self.inst_cols.buf, 0, &nb, 0, self.inst_cols.cap);
            self.inst_cols = Growable { buf: nb, cap };
        }
        self.queue.submit([enc.finish()]);
        self.bg = None;
    }

    pub fn drop_geometry(&mut self, id: u32) {
        self.geoms.remove(&id);
        self.geom_bgs.remove(&id);
    }

    /// Destruye el dispositivo (los renderers secundarios, como los de iconos, no lo dejan vivo hasta el GC).
    pub fn destroy(&self) {
        self.device.destroy();
    }

    pub fn is_lost(&self) -> bool {
        self.status.lock().unwrap().0
    }

    pub fn take_error(&self) -> String {
        std::mem::take(&mut self.status.lock().unwrap().1)
    }

    /// `[dibujos, triangulos, geometrias]` del ultimo fotograma.
    pub fn stats(&self) -> Vec<f32> {
        vec![self.stats[0], self.stats[1], self.geoms.len() as f32]
    }

    /// `flags` de un dibujo: bit 0 doble cara (sin culling), bit 1 giro de caras en sentido horario, bit 2 transparente,
    /// bit 3 escribe profundidad, bit 4 prueba de profundidad. Los bits 5 (FLIP_SIDED) y 6 (DOUBLE_SIDED) solo los usa el shader.
    fn ensure_pipeline(&mut self, flags: u32, fmt: u32) {
        let key = (flags & 31) | (fmt << 5);
        let flags = flags & 31;
        if self.pipelines.contains_key(&key) {
            return;
        }
        let color_format = target_format(fmt, self.cfg.format);
        // como three: siempre se descarta la cara trasera; BackSide y las matrices con determinante negativo cambian el sentido de giro
        let cull = if flags & 1 != 0 { None } else { Some(wgpu::Face::Back) };
        // en un render target la y de clip va invertida: el giro de las caras se invierte tambien
        let cw = (flags & 2 != 0) != (fmt != 0);
        let front = if cw { wgpu::FrontFace::Cw } else { wgpu::FrontFace::Ccw };
        // three NormalBlending: SRC_ALPHA, ONE_MINUS_SRC_ALPHA para el color; ONE, ONE_MINUS_SRC_ALPHA para el alfa
        let blend = (flags & 4 != 0).then_some(wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::SrcAlpha,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        });
        let pl = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: Some(&self.layout),
            vertex: wgpu::VertexState {
                module: &self.module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 68,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 12, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 24, shader_location: 2 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 32, shader_location: 3 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Uint16x4, offset: 44, shader_location: 4 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 52, shader_location: 5 },
                    ],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &self.module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: color_format,
                    blend,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState { cull_mode: cull, front_face: front, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH,
                depth_write_enabled: Some(flags & 8 != 0),
                // three: LEQUAL con prueba de profundidad; sin ella, siempre pasa
                depth_compare: Some(if flags & 16 != 0 { wgpu::CompareFunction::LessEqual } else { wgpu::CompareFunction::Always }),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        self.pipelines.insert(key, pl);
    }

    /// Pipeline de un dibujo de usuario: `flags` como los del material estandar, `b0`/`b1` = mezcla empaquetada (ver pack.ts).
    fn ensure_user_pipeline(&mut self, shader: u32, flags: u32, fmt: u32, b0: u32, b1: u32) {
        let flags = flags & (31 | 2048 | 4096);
        let key = (shader, flags, fmt, b0, b1);
        if self.user_pls.contains_key(&key) {
            return;
        }
        let Some((body, points)) = user_src(shader) else { return };
        if !self.user_modules.contains_key(&shader) {
            let src = format!("{}\n{}\n{}", include_str!("user/_header.wgsl"), if points { include_str!("user/_points.wgsl") } else { "" }, body);
            let m = self.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("phoenyx-user"), source: wgpu::ShaderSource::Wgsl(src.into()) });
            self.user_modules.insert(shader, m);
        }
        let module = &self.user_modules[&shader];
        let lines = flags & 4096 != 0;
        let cull = if flags & 1 != 0 || points || lines { None } else { Some(wgpu::Face::Back) };
        let cw = (flags & 2 != 0) != (fmt != 0);
        let front = if cw { wgpu::FrontFace::Cw } else { wgpu::FrontFace::Ccw };
        // mezcla: b0 = srcRGB | dstRGB << 8 | ecuacion << 16 | modo << 24; b1 = srcA | dstA << 8 | ecuacionA << 16
        let blend = ((b0 >> 24) != 0).then(|| wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: blend_factor(b0 & 255), dst_factor: blend_factor((b0 >> 8) & 255), operation: blend_op((b0 >> 16) & 255) },
            alpha: wgpu::BlendComponent { src_factor: blend_factor(b1 & 255), dst_factor: blend_factor((b1 >> 8) & 255), operation: blend_op((b1 >> 16) & 255) },
        });
        let pl = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: Some(if points { &self.layout_pts } else { &self.layout }),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some("vs_user"),
                compilation_options: Default::default(),
                buffers: if points { &[] } else { &[Some(wgpu::VertexBufferLayout {
                    array_stride: 68,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 12, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 24, shader_location: 2 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 32, shader_location: 3 },
                    ],
                })] },
            },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some("fs_user"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: target_format(fmt, self.cfg.format), blend, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState { topology: if lines { wgpu::PrimitiveTopology::LineList } else { wgpu::PrimitiveTopology::TriangleList }, cull_mode: cull, front_face: front, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH,
                depth_write_enabled: Some(flags & 8 != 0),
                depth_compare: Some(if flags & 16 != 0 { wgpu::CompareFunction::LessEqual } else { wgpu::CompareFunction::Always }),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        self.user_pls.insert(key, pl);
    }

    /// Reserva los mapas de sombra (una capa por luz con sombra, todas de `size` x `size`). Deja los mapas vacios.
    pub fn set_shadow_maps(&mut self, layers: u32, size: u32) {
        let (all, each) = shadow_views(&self.device, layers.max(1), size.max(1));
        self.shadow_all = all;
        self.shadow_layers = each;
        self.bg = None;
    }

    fn ensure_shadow_pipeline(&mut self, flags: u32) {
        // clave: bits 0 y 1 (doble cara, giro horario) y bit 9 (descarte por alfa del mapa)
        let key = (flags & 3) | ((flags >> 9) & 1) << 2;
        if self.shadow_pipelines.contains_key(&key) {
            return;
        }
        let cull = if key & 1 != 0 { None } else { Some(wgpu::Face::Back) };
        let front = if key & 2 != 0 { wgpu::FrontFace::Cw } else { wgpu::FrontFace::Ccw };
        let pl = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: Some(&self.layout),
            vertex: wgpu::VertexState {
                module: &self.module,
                entry_point: Some("vs_shadow"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 68,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 12, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 24, shader_location: 2 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 32, shader_location: 3 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Uint16x4, offset: 44, shader_location: 4 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 52, shader_location: 5 },
                    ],
                })],
            },
            fragment: (key & 4 != 0).then(|| wgpu::FragmentState {
                module: &self.module,
                entry_point: Some("fs_shadow"),
                compilation_options: Default::default(),
                targets: &[],
            }),
            primitive: wgpu::PrimitiveState { cull_mode: cull, front_face: front, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::LessEqual),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        self.shadow_pipelines.insert(key, pl);
    }

    /// Un pase de pantalla completa sobre el destino actual (`set_target`). `shader` es el indice del fragment en
    /// `post.wgsl` (ver pass-registry.ts); `blend` = [modo (0 sin mezcla), srcRGB, dstRGB, ecuacion, srcA, dstA, ecuacionA]
    /// con las constantes de three; `tex`: ids de las 5 texturas filtrables y de la de profundidad (0 = blanca).
    pub fn pass(&mut self, shader: u32, uniforms: &[f32], blend: &[u32], tex: &[u32]) -> bool {
        let entry = match shader {
            0 => "fs_copy",
            1 => "fs_output",
            2 => "fs_lum",
            3 => "fs_blur",
            4 => "fs_bloom",
            5 => "fs_smaa_edges",
            6 => "fs_smaa_weights",
            7 => "fs_smaa_blend",
            8 => "fs_gtao",
            9 => "fs_denoise",
            10 => "fs_aoblend",
            11 => "fs_aodepth",
            12 => "fs_film",
            13 => "fs_vhs",
            14 => "fs_pmrem_blur",
            _ => return false,
        };
        let mut bl = [0u32; 7];
        for (d, s) in bl.iter_mut().zip(blend) {
            *d = *s;
        }
        let fmt = self.targets.get(&self.cur).map(|t| t.fmt).unwrap_or(0);
        let key = (shader, bl, fmt);
        if !self.post_pls.contains_key(&key) {
            let blend_state = (bl[0] != 0).then(|| wgpu::BlendState {
                color: wgpu::BlendComponent { src_factor: blend_factor(bl[1]), dst_factor: blend_factor(bl[2]), operation: blend_op(bl[3]) },
                alpha: wgpu::BlendComponent { src_factor: blend_factor(bl[4]), dst_factor: blend_factor(bl[5]), operation: blend_op(bl[6]) },
            });
            let pl = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: None,
                layout: Some(&self.post_layout),
                vertex: wgpu::VertexState {
                    module: &self.post_module,
                    entry_point: Some(if fmt != 0 { "vs_flip" } else { "vs" }),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &self.post_module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format: target_format(fmt, self.cfg.format), blend: blend_state, write_mask: wgpu::ColorWrites::ALL })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            });
            self.post_pls.insert(key, PassPl { pl });
        }
        if self.post_n >= POST_MAX {
            self.flush();
        }
        // cada pase de la tanda lee sus uniformes de su propio tramo del buffer (los write_buffer llegan todos antes del submit)
        let off = (self.post_n * POST_STRIDE) as u64;
        let n = uniforms.len().min((POST_STRIDE / 4) as usize);
        self.queue.write_buffer(&self.post_uniforms, off, bytemuck::cast_slice(&uniforms[..n]));
        let view_of = |i: usize| -> &wgpu::TextureView { tex.get(i).and_then(|id| self.textures.get(id)).unwrap_or(&self.white) };
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.post_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.post_uniforms, offset: off, size: wgpu::BufferSize::new(POST_STRIDE as u64) }) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view_of(0)) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(view_of(1)) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(view_of(2)) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(view_of(3)) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(view_of(4)) },
                wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(view_of(5)) },
                wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(&self.samp_linear) },
                wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::Sampler(&self.samp_nearest) },
            ],
        });
        let view = match self.targets.get(&self.cur) {
            Some(t) => t.view.clone(),
            None => {
                if self.post_frame.is_none() {
                    match self.surface.get_current_texture() {
                        wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => self.post_frame = Some(f),
                        _ => {
                            self.surface.configure(&self.device, &self.cfg);
                            return false;
                        }
                    }
                }
                self.post_frame.as_ref().unwrap().texture.create_view(&Default::default())
            }
        };
        let pend = self.pending.remove(&self.cur).unwrap_or_default();
        let rects = self.vp_rects();
        if self.post_enc.is_none() {
            self.post_enc = Some(self.device.create_command_encoder(&Default::default()));
        }
        {
            let mut p = self.post_enc.as_mut().unwrap().begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: match pend.color {
                            Some(c) => wgpu::LoadOp::Clear(wgpu::Color { r: c[0], g: c[1], b: c[2], a: c[3] }),
                            None => wgpu::LoadOp::Load,
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            p.set_pipeline(&self.post_pls[&key].pl);
            p.set_bind_group(0, &bg, &[]);
            apply_rects(&mut p, rects);
            p.draw(0..3, 0..1);
        }
        self.post_n += 1;
        true
    }

    /// Viewport y scissor del destino actual (solo render targets), recortados al tamano del destino.
    fn vp_rects(&self) -> (Option<[u32; 4]>, Option<[u32; 4]>) {
        let Some(t) = self.targets.get(&self.cur) else { return (None, None) };
        let clampr = |r: [u32; 4]| -> Option<[u32; 4]> {
            if r[2] == 0 || r[3] == 0 || r[0] >= t.w || r[1] >= t.h {
                return None;
            }
            Some([r[0], r[1], r[2].min(t.w - r[0]), r[3].min(t.h - r[1])])
        };
        (clampr(self.vp), clampr(self.sc))
    }

    /// Dibuja un fotograma. Los formatos de los arrays: ver docs/FASE1.md.
    /// `draws`: 12 u32 por dibujo `[geometria, objeto, material, flags, primer indice, n indices, clave de texturas, malla instanciada (u32::MAX si no), n instancias, primera instancia, 0, 0]`, ya en el orden final de pintado.
    pub fn frame(&mut self, globals: &[f32], objects: &[f32], materials: &[f32], lights: &[f32], draws: &[u32], shadows: &[f32], shadow_passes: &[u32], main_draws: u32) -> bool {
        if globals.len() < GLOBALS_F {
            return false;
        }
        // lo grabado por los pases va antes que este fotograma (y sus escrituras de buffers)
        self.flush();
        self.clear = [globals[44] as f64, globals[45] as f64, globals[46] as f64, globals[47] as f64];
        self.queue.write_buffer(&self.globals, 0, bytemuck::cast_slice(&globals[..GLOBALS_F]));
        let mut grew = self.objects.write(&self.device, &self.queue, bytemuck::cast_slice(objects));
        grew |= self.materials.write(&self.device, &self.queue, bytemuck::cast_slice(materials));
        grew |= self.lights.write(&self.device, &self.queue, bytemuck::cast_slice(lights));
        grew |= self.shadows.write(&self.device, &self.queue, bytemuck::cast_slice(shadows));
        // la malla instanciada se resuelve a su plaza de la reserva; el indice de dibujo va en los 16 bits altos de la instancia
        let mut dr = draws.to_vec();
        for c in dr.chunks_exact_mut(12) {
            // dibujo de usuario (ShaderMaterial): sin huesos; si es instanciado (c[7] = malla), solo se resuelve su plaza (c[9] lleva la mezcla)
            if c[3] & 1024 != 0 {
                if c[7] != u32::MAX {
                    match self.slots.get(&c[7]) {
                        Some(sl) => {
                            c[7] = sl.offset;
                            c[8] = c[8].min(sl.n);
                        }
                        None => c[8] = 0,
                    }
                }
                continue;
            }
            // tramo de huesos de una malla con piel: c[11] = su clave; el shader recibe offset + 1 (0 = sin piel)
            if c[11] != 0 {
                c[11] = self.slots.get(&c[11]).map_or(0, |sl| sl.offset + 1);
            }
            if c[7] != u32::MAX {
                match self.slots.get(&c[7]) {
                    Some(sl) => {
                        c[7] = sl.offset + c[9];
                        c[8] = c[8].min(sl.n.saturating_sub(c[9]));
                    }
                    None => c[8] = 0,
                }
            }
        }
        let draws = &dr[..];
        grew |= self.draws.write(&self.device, &self.queue, bytemuck::cast_slice(draws));
        if grew || self.bg.is_none() {
            self.bg = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.bgl,
                entries: &[
                    entry(0, &self.globals),
                    entry(1, &self.objects.buf),
                    entry(2, &self.materials.buf),
                    entry(3, &self.lights.buf),
                    entry(4, &self.draws.buf),
                    entry(5, &self.inst_mats.buf),
                    entry(6, &self.inst_cols.buf),
                    wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::TextureView(&self.ltc1) },
                    wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::TextureView(&self.ltc2) },
                    wgpu::BindGroupEntry { binding: 11, resource: wgpu::BindingResource::TextureView(&self.lm0) },
                    wgpu::BindGroupEntry { binding: 12, resource: wgpu::BindingResource::TextureView(&self.lm1) },
                    wgpu::BindGroupEntry { binding: 13, resource: wgpu::BindingResource::Sampler(&self.lm_smp) },
                    wgpu::BindGroupEntry { binding: 14, resource: wgpu::BindingResource::TextureView(self.textures.get(&self.env_id).unwrap_or(&self.env)) },
                    entry(9, &self.shadows.buf),
                    wgpu::BindGroupEntry { binding: 10, resource: wgpu::BindingResource::TextureView(&self.shadow_all) },
                ],
            }));
            // la pasada de sombras no puede leer el mapa que esta escribiendo: usa un mapa vacio en su lugar
            self.bg_shadow = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.bgl,
                entries: &[
                    entry(0, &self.globals),
                    entry(1, &self.objects.buf),
                    entry(2, &self.materials.buf),
                    entry(3, &self.lights.buf),
                    entry(4, &self.draws.buf),
                    entry(5, &self.inst_mats.buf),
                    entry(6, &self.inst_cols.buf),
                    wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::TextureView(&self.ltc1) },
                    wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::TextureView(&self.ltc2) },
                    wgpu::BindGroupEntry { binding: 11, resource: wgpu::BindingResource::TextureView(&self.lm0) },
                    wgpu::BindGroupEntry { binding: 12, resource: wgpu::BindingResource::TextureView(&self.lm1) },
                    wgpu::BindGroupEntry { binding: 13, resource: wgpu::BindingResource::Sampler(&self.lm_smp) },
                    wgpu::BindGroupEntry { binding: 14, resource: wgpu::BindingResource::TextureView(self.textures.get(&self.env_id).unwrap_or(&self.env)) },
                    entry(9, &self.shadows.buf),
                    wgpu::BindGroupEntry { binding: 10, resource: wgpu::BindingResource::TextureView(&self.shadow_dummy) },
                ],
            }));
        }
        let nmain = (main_draws as usize * 12).min(draws.len());
        let rects = self.vp_rects();
        let (tfmt, tview, tdepth) = match self.targets.get(&self.cur) {
            Some(t) => (t.fmt, Some(t.view.clone()), Some(t.depth.clone())),
            None => (0, None, None),
        };
        for d in draws[..nmain].chunks_exact(12) {
            if d[3] & 1024 != 0 {
                self.ensure_user_pipeline(d[10], d[3], tfmt, d[9], d[11]);
                if d[3] & 2048 != 0 && !self.geom_bgs.contains_key(&d[0]) {
                    if let Some(g) = self.geoms.get(&d[0]) {
                        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.geom_bgl, entries: &[entry(0, &g.vb)] });
                        self.geom_bgs.insert(d[0], bg);
                    }
                }
            } else {
                self.ensure_pipeline(d[3], tfmt);
            }
            self.ensure_tex_bg(d[6]);
        }
        for d in draws[nmain..].chunks_exact(12) {
            self.ensure_shadow_pipeline(d[3]);
            self.ensure_tex_bg(d[6]);
        }
        let (view, _frame) = match tview {
            Some(v) => (v, None),
            None => {
                let frame = match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
                    _ => {
                        self.surface.configure(&self.device, &self.cfg);
                        return false;
                    }
                };
                (frame.texture.create_view(&Default::default()), Some(frame))
            }
        };
        let depth_view = tdepth.as_ref().unwrap_or(&self.depth).clone();
        // limpieza: la de clear() pendiente, o la de autoClear (globals[48]: bit 0 color, bit 1 profundidad)
        let pend = self.pending.remove(&self.cur).unwrap_or_default();
        // la limpieza del propio render (autoClear o scene.background) se hace despues de clear(): su color manda, como en three
        let clear_color = (globals[48] as u32 & 1 != 0).then_some(self.clear).or(pend.color);
        let clear_depth = pend.depth || (globals[48] as u32 & 2 != 0);
        let mut enc = self.device.create_command_encoder(&Default::default());
        let mut tris = 0u64;
        // pasadas de sombras: [capa, primer dibujo, n dibujos, ancho, alto] por luz que se repinta
        for sp in shadow_passes.chunks_exact(5) {
            let Some(layer) = self.shadow_layers.get(sp[0] as usize) else { continue };
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: layer,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            p.set_viewport(0.0, 0.0, sp[3] as f32, sp[4] as f32, 0.0, 1.0);
            p.set_bind_group(0, self.bg_shadow.as_ref(), &[]);
            let mut last_key = u32::MAX;
            for i in sp[1] as usize..(sp[1] + sp[2]) as usize {
                let d = &draws[i * 12..i * 12 + 12];
                let Some(g) = self.geoms.get(&d[0]) else { continue };
                if d[8] == 0 || i >= 65536 {
                    continue;
                }
                let key = (d[3] & 3) | ((d[3] >> 9) & 1) << 2;
                p.set_pipeline(&self.shadow_pipelines[&key]);
                if d[6] != last_key {
                    p.set_bind_group(1, &self.bgs[&d[6]], &[]);
                    last_key = d[6];
                }
                p.set_vertex_buffer(0, g.vb.slice(..));
                p.set_index_buffer(g.ib.slice(..), wgpu::IndexFormat::Uint32);
                let (first, n) = (d[4].min(g.n), d[5].min(g.n.saturating_sub(d[4].min(g.n))));
                let base = (i as u32) << 16;
                p.draw_indexed(first..first + n, 0, base..base + d[8]);
            }
        }
        {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: match clear_color {
                            Some(c) => wgpu::LoadOp::Clear(wgpu::Color { r: c[0], g: c[1], b: c[2], a: c[3] }),
                            None => wgpu::LoadOp::Load,
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view,
                    depth_ops: Some(wgpu::Operations { load: if clear_depth { wgpu::LoadOp::Clear(1.0) } else { wgpu::LoadOp::Load }, store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            apply_rects(&mut p, rects);
            p.set_bind_group(0, self.bg.as_ref(), &[]);
            let mut last_key = u32::MAX;
            for (i, d) in draws[..nmain].chunks_exact(12).enumerate() {
                let Some(g) = self.geoms.get(&d[0]) else { continue };
                if d[8] == 0 || i >= 65536 {
                    continue;
                }
                if d[3] & 1024 != 0 {
                    // dibujo de usuario: sin pipeline (shader no registrado) no se pinta
                    let Some(up) = self.user_pls.get(&(d[10], d[3] & (31 | 2048 | 4096), tfmt, d[9], d[11])) else { continue };
                    p.set_pipeline(up);
                    if d[6] != last_key {
                        p.set_bind_group(1, &self.bgs[&d[6]], &[]);
                        last_key = d[6];
                    }
                    if d[3] & 2048 != 0 {
                        // Points: seis vertices por punto, leidos del buffer de la geometria (grupo 2)
                        let Some(bg) = self.geom_bgs.get(&d[0]) else { continue };
                        p.set_bind_group(2, bg, &[]);
                        let first = d[4].min(g.nv);
                        let n = d[5].min(g.nv - first);
                        let base = (i as u32) << 16;
                        p.draw(first * 6..(first + n) * 6, base..base + 1);
                        continue;
                    }
                } else {
                    p.set_pipeline(&self.pipelines[&((d[3] & 31) | (tfmt << 5))]);
                }
                if d[6] != last_key {
                    p.set_bind_group(1, &self.bgs[&d[6]], &[]);
                    last_key = d[6];
                }
                p.set_vertex_buffer(0, g.vb.slice(..));
                p.set_index_buffer(g.ib.slice(..), wgpu::IndexFormat::Uint32);
                let (first, n) = (d[4].min(g.n), d[5].min(g.n.saturating_sub(d[4].min(g.n))));
                let base = (i as u32) << 16;
                p.draw_indexed(first..first + n, 0, base..base + d[8]);
                tris += (n / 3) as u64 * d[8] as u64;
            }
        }
        self.queue.submit([enc.finish()]);
        self.stats = [(nmain / 12) as f32, tris as f32, 0.0];
        true
    }
}
