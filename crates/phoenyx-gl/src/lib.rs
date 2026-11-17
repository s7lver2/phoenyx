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
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[Some(&bgl)],
        immediate_size: 0,
    });
    let globals = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (GLOBALS_F * 4) as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    Ok(Gl {
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
    pub fn set_geometry(&mut self, id: u32, positions: &[f32], normals: &[f32], uvs: &[f32], indices: &[u32]) {
        let n = positions.len() / 3;
        let mut v: Vec<f32> = Vec::with_capacity(n * 8);
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
                    array_stride: 32,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 12, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 24, shader_location: 2 },
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
    /// `draws`: 4 u32 por dibujo `[geometria, objeto, material, flags]`, ya en el orden final de pintado.
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
        for d in draws.chunks_exact(4) {
            self.ensure_pipeline(d[3]);
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
            for (i, d) in draws.chunks_exact(4).enumerate() {
                let Some(g) = self.geoms.get(&d[0]) else { continue };
                p.set_pipeline(&self.pipelines[&(d[3] & 31)]);
                p.set_vertex_buffer(0, g.vb.slice(..));
                p.set_index_buffer(g.ib.slice(..), wgpu::IndexFormat::Uint32);
                p.draw_indexed(0..g.n, 0, i as u32..i as u32 + 1);
                tris += (g.n / 3) as u64;
            }
        }
        self.queue.submit([enc.finish()]);
        self.stats = [(draws.len() / 4) as f32, tris as f32, 0.0];
    }
}
