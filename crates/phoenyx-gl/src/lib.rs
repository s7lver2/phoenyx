// phoenyx-gl: renderer WebGPU que dibuja lo que le manda el paquete TypeScript `phoenyx` (la API de three).
// Recibe arrays tipados por fotograma (globales, objetos, materiales, luces, lista de dibujos ya ordenada) y los pinta
// con el sombreado portado de three 0.160.1 (ver shader.wgsl). Los formatos de los arrays estan en docs/FASE1.md.
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// Floats por entrada de cada array de entrada (deben coincidir con shader.wgsl y con pack.ts).
pub const GLOBALS_F: usize = 64;

thread_local! {
    static STATUS: std::cell::RefCell<(bool, String)> = const { std::cell::RefCell::new((false, String::new())) };
}

fn entry(b: u32, buf: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding: b, resource: buf.as_entire_binding() }
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

struct Geom {
    vb: wgpu::Buffer,
    ib: wgpu::Buffer,
    n: u32,
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
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
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
    default_sampler: wgpu::Sampler,
    lut: Box<[f32; 256]>,
    globals: wgpu::Buffer,
    objects: Growable,
    materials: Growable,
    lights: Growable,
    draws: Growable,
    bg: Option<wgpu::BindGroup>,
    pipelines: HashMap<u32, wgpu::RenderPipeline>,
    geoms: HashMap<u32, Geom>,
    clear: [f64; 4],
    stats: [f32; 3],
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
    device.on_uncaptured_error(std::sync::Arc::new(|e: wgpu::Error| {
        STATUS.with(|s| s.borrow_mut().1 = e.to_string());
    }));
    device.set_device_lost_callback(|reason, msg| {
        STATUS.with(|s| *s.borrow_mut() = (true, format!("{reason:?}: {msg}")));
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
        source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
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
    Ok(Gl {
        tex_bgl,
        textures: HashMap::new(),
        samplers: HashMap::new(),
        bg_desc: HashMap::new(),
        bgs: HashMap::new(),
        white,
        default_sampler,
        lut,
        depth: depth_view(&device, w, h),
        objects: Growable::new(&device, 4096),
        materials: Growable::new(&device, 1024),
        lights: Growable::new(&device, 1024),
        draws: Growable::new(&device, 1024),
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
    })
}

#[wasm_bindgen]
impl Gl {
    pub fn resize(&mut self, w: u32, h: u32) {
        let (w, h) = (w.max(1), h.max(1));
        if (w, h) == (self.cfg.width, self.cfg.height) {
            return;
        }
        self.cfg.width = w;
        self.cfg.height = h;
        self.surface.configure(&self.device, &self.cfg);
        self.depth = depth_view(&self.device, w, h);
    }

    /// Crea o reemplaza una geometria: posiciones y normales de 3 floats, uvs de 2 (puede venir vacio) e indices u32.
    pub fn set_geometry(&mut self, id: u32, positions: &[f32], normals: &[f32], uvs: &[f32], colors: &[f32], indices: &[u32]) {
        let n = positions.len() / 3;
        let mut v: Vec<f32> = Vec::with_capacity(n * 11);
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
        }
        let vb = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(&v),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let ib = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(indices),
            usage: wgpu::BufferUsages::INDEX,
        });
        self.geoms.insert(id, Geom { vb, ib, n: indices.len() as u32 });
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

    pub fn drop_geometry(&mut self, id: u32) {
        self.geoms.remove(&id);
    }

    pub fn is_lost(&self) -> bool {
        STATUS.with(|s| s.borrow().0)
    }

    pub fn take_error(&self) -> String {
        STATUS.with(|s| std::mem::take(&mut s.borrow_mut().1))
    }

    /// `[dibujos, triangulos, geometrias]` del ultimo fotograma.
    pub fn stats(&self) -> Vec<f32> {
        vec![self.stats[0], self.stats[1], self.geoms.len() as f32]
    }

    /// `flags` de un dibujo: bit 0 doble cara (sin culling), bit 1 giro de caras en sentido horario, bit 2 transparente,
    /// bit 3 escribe profundidad, bit 4 prueba de profundidad. Los bits 5 (FLIP_SIDED) y 6 (DOUBLE_SIDED) solo los usa el shader.
    fn ensure_pipeline(&mut self, flags: u32) {
        let flags = flags & 31;
        if self.pipelines.contains_key(&flags) {
            return;
        }
        // como three: siempre se descarta la cara trasera; BackSide y las matrices con determinante negativo cambian el sentido de giro
        let cull = if flags & 1 != 0 { None } else { Some(wgpu::Face::Back) };
        let front = if flags & 2 != 0 { wgpu::FrontFace::Cw } else { wgpu::FrontFace::Ccw };
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
                    array_stride: 44,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 12, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 24, shader_location: 2 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 32, shader_location: 3 },
                    ],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &self.module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: self.cfg.format,
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
        self.pipelines.insert(flags, pl);
    }

    /// Dibuja un fotograma. Los formatos de los arrays: ver docs/FASE1.md.
    /// `draws`: 8 u32 por dibujo `[geometria, objeto, material, flags, primer indice, n indices, clave de texturas, 0]`, ya en el orden final de pintado.
    pub fn frame(&mut self, globals: &[f32], objects: &[f32], materials: &[f32], lights: &[f32], draws: &[u32]) {
        if globals.len() < GLOBALS_F {
            return;
        }
        self.clear = [globals[44] as f64, globals[45] as f64, globals[46] as f64, globals[47] as f64];
        self.queue.write_buffer(&self.globals, 0, bytemuck::cast_slice(&globals[..GLOBALS_F]));
        let mut grew = self.objects.write(&self.device, &self.queue, bytemuck::cast_slice(objects));
        grew |= self.materials.write(&self.device, &self.queue, bytemuck::cast_slice(materials));
        grew |= self.lights.write(&self.device, &self.queue, bytemuck::cast_slice(lights));
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
                ],
            }));
        }
        for d in draws.chunks_exact(8) {
            self.ensure_pipeline(d[3]);
            self.ensure_tex_bg(d[6]);
        }
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            _ => {
                self.surface.configure(&self.device, &self.cfg);
                return;
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let mut enc = self.device.create_command_encoder(&Default::default());
        let mut tris = 0u64;
        {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: self.clear[0], g: self.clear[1], b: self.clear[2], a: self.clear[3] }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            p.set_bind_group(0, self.bg.as_ref(), &[]);
            let mut last_key = u32::MAX;
            for (i, d) in draws.chunks_exact(8).enumerate() {
                let Some(g) = self.geoms.get(&d[0]) else { continue };
                p.set_pipeline(&self.pipelines[&(d[3] & 31)]);
                if d[6] != last_key {
                    p.set_bind_group(1, &self.bgs[&d[6]], &[]);
                    last_key = d[6];
                }
                p.set_vertex_buffer(0, g.vb.slice(..));
                p.set_index_buffer(g.ib.slice(..), wgpu::IndexFormat::Uint32);
                let (first, n) = (d[4].min(g.n), d[5].min(g.n.saturating_sub(d[4].min(g.n))));
                p.draw_indexed(first..first + n, 0, i as u32..i as u32 + 1);
                tris += (n / 3) as u64;
            }
        }
        self.queue.submit([enc.finish()]);
        self.stats = [(draws.len() / 8) as f32, tris as f32, 0.0];
    }
}
