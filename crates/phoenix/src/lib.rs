//! Phoenix M0: culling + LOD en GPU y dibujo indirecto (WebGPU).
//! La CPU solo sube una matriz por frame y encola 1 compute + 3 draws indirectos.
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use std::{cell::Cell, rc::Rc};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
// Subdivisiones de la icosfera por LOD: 5120, 320 y 80 triangulos.
const LODS: [u32; 3] = [4, 2, 1];
// Umbrales de LOD en pixeles de diametro en pantalla.
const LOD_PX: [f32; 2] = [60.0, 14.0];
const FOV: f32 = 1.1;
const SPACING: f32 = 6.0;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Globals {
    view_proj: [f32; 16],
    cam: [f32; 4],
    planes: [[f32; 4]; 6],
    lod: [f32; 4],
    light: [f32; 4],
}

/// Icosfera unitaria: solo posiciones (la normal es la posicion) e indices u16.
fn icosphere(sub: u32) -> (Vec<[f32; 3]>, Vec<u16>) {
    let t = (1.0 + 5f32.sqrt()) / 2.0;
    let mut v: Vec<Vec3> = [
        (-1., t, 0.), (1., t, 0.), (-1., -t, 0.), (1., -t, 0.),
        (0., -1., t), (0., 1., t), (0., -1., -t), (0., 1., -t),
        (t, 0., -1.), (t, 0., 1.), (-t, 0., -1.), (-t, 0., 1.),
    ]
    .iter()
    .map(|&(x, y, z)| Vec3::new(x, y, z).normalize())
    .collect();
    let mut f: Vec<[u32; 3]> = vec![
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for _ in 0..sub {
        let mut cache = std::collections::HashMap::new();
        let mut mid = |a: u32, b: u32, v: &mut Vec<Vec3>| -> u32 {
            let k = (a.min(b), a.max(b));
            *cache.entry(k).or_insert_with(|| {
                v.push(((v[a as usize] + v[b as usize]) * 0.5).normalize());
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
    (
        v.iter().map(|p| p.to_array()).collect(),
        f.iter().flatten().map(|&i| i as u16).collect(),
    )
}

struct Ts {
    qs: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    period: f32,
}

#[wasm_bindgen]
pub struct Phoenix {
    surface: wgpu::Surface<'static>,
    cfg: wgpu::SurfaceConfiguration,
    device: wgpu::Device,
    queue: wgpu::Queue,
    depth: wgpu::TextureView,
    globals: wgpu::Buffer,
    args: wgpu::Buffer,
    staging: wgpu::Buffer,
    cull_pl: wgpu::ComputePipeline,
    cull_bg: wgpu::BindGroup,
    draw_pl: wgpu::RenderPipeline,
    draw_bg: wgpu::BindGroup,
    vis_bg: [wgpu::BindGroup; 3],
    vbuf: wgpu::Buffer,
    ibuf: wgpu::Buffer,
    // (indices, primer indice, vertice base) por LOD
    lods: [(u32, u32, i32); 3],
    n: u32,
    extent: f32,
    frame: u64,
    busy: Rc<Cell<bool>>,
    counts: Rc<Cell<[u32; 3]>>,
    ts: Option<Ts>,
    // ms de GPU: [cull, render] segun el ultimo readback
    gpu: Rc<Cell<[f32; 2]>>,
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

fn storage(ty: wgpu::BufferBindingType, binding: u32, vis: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: vis,
        ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

#[wasm_bindgen]
pub async fn create(canvas: web_sys::HtmlCanvasElement, count: u32) -> Result<Phoenix, JsValue> {
    console_error_panic_hook::set_once();
    let (w, h) = (canvas.width().max(1), canvas.height().max(1));
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            ..Default::default()
        })
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            required_features: adapter.features() & wgpu::Features::TIMESTAMP_QUERY,
            ..Default::default()
        })
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let mut cfg = surface
        .get_default_config(&adapter, w, h)
        .ok_or("superficie sin config")?;
    cfg.present_mode = wgpu::PresentMode::AutoVsync;
    surface.configure(&device, &cfg);

    // Malla: un solo vertex/index buffer con los 3 LOD concatenados.
    let (mut verts, mut idx, mut lods) = (Vec::new(), Vec::new(), [(0, 0, 0); 3]);
    for (k, &s) in LODS.iter().enumerate() {
        let (v, i) = icosphere(s);
        lods[k] = (i.len() as u32, idx.len() as u32, verts.len() as i32);
        verts.extend(v);
        idx.extend(i);
    }
    let vbuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None, contents: bytemuck::cast_slice(&verts), usage: wgpu::BufferUsages::VERTEX,
    });
    // u16 con relleno a multiplo de 4 bytes.
    if idx.len() % 2 == 1 { idx.push(0); }
    let ibuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None, contents: bytemuck::cast_slice(&idx), usage: wgpu::BufferUsages::INDEX,
    });

    // Instancias en rejilla con altura pseudoaleatoria y escala variable.
    let side = (count as f32).sqrt().ceil() as u32;
    let extent = side as f32 * SPACING;
    let insts: Vec<[f32; 4]> = (0..count)
        .map(|i| {
            let (x, z) = ((i % side) as f32, (i / side) as f32);
            let hsh = (i.wrapping_mul(2654435761) >> 8 & 0xffff) as f32 / 65535.0;
            [x * SPACING, hsh * 6.0, z * SPACING, 1.0 + hsh * 1.5]
        })
        .collect();
    let inst_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None, contents: bytemuck::cast_slice(&insts), usage: wgpu::BufferUsages::STORAGE,
    });
    let globals = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: size_of::<Globals>() as u64, mapped_at_creation: false,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let args = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: 60, mapped_at_creation: false,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT
            | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
    });
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: None, size: 96, mapped_at_creation: false,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
    });
    let vis: [wgpu::Buffer; 3] = std::array::from_fn(|_| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: count as u64 * 4, mapped_at_creation: false,
            usage: wgpu::BufferUsages::STORAGE,
        })
    });

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None, source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
    });
    use wgpu::{BufferBindingType as B, ShaderStages as S};
    let uni = |vis| wgpu::BindGroupLayoutEntry {
        binding: 0, visibility: vis, count: None,
        ty: wgpu::BindingType::Buffer {
            ty: B::Uniform, has_dynamic_offset: false, min_binding_size: None,
        },
    };
    let ro = B::Storage { read_only: true };
    let rw = B::Storage { read_only: false };
    let cull_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            uni(S::COMPUTE), storage(ro, 1, S::COMPUTE), storage(rw, 2, S::COMPUTE),
            storage(rw, 3, S::COMPUTE), storage(rw, 4, S::COMPUTE), storage(rw, 5, S::COMPUTE),
        ],
    });
    let draw_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[uni(S::VERTEX | S::FRAGMENT), storage(ro, 1, S::VERTEX)],
    });
    let vis_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None, entries: &[storage(ro, 0, S::VERTEX)],
    });
    let bind = |l: &wgpu::BindGroupLayout, bs: &[(u32, &wgpu::Buffer)]| {
        let e: Vec<_> = bs
            .iter()
            .map(|&(binding, b)| wgpu::BindGroupEntry { binding, resource: b.as_entire_binding() })
            .collect();
        device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: l, entries: &e })
    };
    let cull_bg = bind(&cull_l, &[(0, &globals), (1, &inst_buf), (2, &args), (3, &vis[0]), (4, &vis[1]), (5, &vis[2])]);
    let draw_bg = bind(&draw_l, &[(0, &globals), (1, &inst_buf)]);
    let vis_bg = [bind(&vis_l, &[(0, &vis[0])]), bind(&vis_l, &[(0, &vis[1])]), bind(&vis_l, &[(0, &vis[2])])];

    let cull_pl = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[Some(&cull_l)], immediate_size: 0,
        })),
        module: &module, entry_point: Some("cull"),
        compilation_options: Default::default(), cache: None,
    });
    let draw_pl = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[Some(&draw_l), Some(&vis_l)], immediate_size: 0,
        })),
        vertex: wgpu::VertexState {
            module: &module, entry_point: Some("vs"), compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 12,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x3],
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

    let ts = device.features().contains(wgpu::Features::TIMESTAMP_QUERY).then(|| Ts {
        qs: device.create_query_set(&wgpu::QuerySetDescriptor {
            label: None, ty: wgpu::QueryType::Timestamp, count: 4,
        }),
        resolve: device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: 32, mapped_at_creation: false,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        }),
        period: queue.get_timestamp_period(),
    });
    let depth = depth_view(&device, w, h);
    Ok(Phoenix {
        surface, cfg, device, queue, depth, globals, args, staging, cull_pl, cull_bg, draw_pl,
        draw_bg, vis_bg, vbuf, ibuf, lods, n: count, extent, frame: 0,
        busy: Rc::new(Cell::new(false)), counts: Rc::new(Cell::new([0; 3])),
        ts, gpu: Rc::new(Cell::new([0.0; 2])),
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

    /// Instancias visibles por LOD en el ultimo readback (llega con unos frames de retraso).
    pub fn counts(&self) -> Vec<u32> {
        self.counts.get().to_vec()
    }

    /// Triangulos dibujados segun el ultimo readback.
    pub fn triangles(&self) -> f64 {
        let c = self.counts.get();
        (0..3).map(|k| c[k] as f64 * (self.lods[k].0 / 3) as f64).sum()
    }

    /// [cull_ms, render_ms] de GPU (vacio si no hay timestamp-query).
    pub fn gpu_ms(&self) -> Vec<f32> {
        if self.ts.is_some() { self.gpu.get().to_vec() } else { vec![] }
    }

    pub fn frame(&mut self, t: f64) {
        let t = t as f32;
        // Camara: circulo sobre la rejilla mirando en la tangente.
        let c = self.extent * 0.5;
        let r = self.extent * 0.3;
        let a = t * 0.08;
        let eye = Vec3::new(c + r * a.cos(), 22.0, c + r * a.sin());
        let dir = Vec3::new(-a.sin(), -0.12, a.cos());
        let aspect = self.cfg.width as f32 / self.cfg.height as f32;
        let vp = Mat4::perspective_rh(FOV, aspect, 0.3, 1500.0) * Mat4::look_to_rh(eye, dir, Vec3::Y);
        let m = vp.transpose();
        let (r0, r1, r2, r3) = (m.col(0), m.col(1), m.col(2), m.col(3));
        let planes = [r3 + r0, r3 - r0, r3 + r1, r3 - r1, r2, r3 - r2].map(|p| {
            let l = p.truncate().length();
            (p / l).to_array()
        });
        let g = Globals {
            view_proj: vp.to_cols_array(),
            cam: [eye.x, eye.y, eye.z, self.cfg.height as f32 / (2.0 * (FOV * 0.5).tan())],
            planes,
            lod: [LOD_PX[0], LOD_PX[1], 2.6, self.n as f32],
            light: [0.5, 0.8, 0.3, 0.0],
        };
        self.queue.write_buffer(&self.globals, 0, bytemuck::bytes_of(&g));
        // Argumentos indirectos: contadores a 0 cada frame.
        let mut a = [0u32; 15];
        for (k, &(ic, fi, bv)) in self.lods.iter().enumerate() {
            a[k * 5] = ic;
            a[k * 5 + 2] = fi;
            a[k * 5 + 3] = bv as u32;
        }
        self.queue.write_buffer(&self.args, 0, bytemuck::cast_slice(&a));

        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            _ => {
                self.surface.configure(&self.device, &self.cfg);
                return;
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut p = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: self.ts.as_ref().map(|t| wgpu::ComputePassTimestampWrites {
                    query_set: &t.qs,
                    beginning_of_pass_write_index: Some(0),
                    end_of_pass_write_index: Some(1),
                }),
            });
            p.set_pipeline(&self.cull_pl);
            p.set_bind_group(0, &self.cull_bg, &[]);
            p.dispatch_workgroups(self.n.div_ceil(64), 1, 1);
        }
        {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view, depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.08, g: 0.07, b: 0.03, a: 1.0 }),
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
            p.set_pipeline(&self.draw_pl);
            p.set_bind_group(0, &self.draw_bg, &[]);
            p.set_vertex_buffer(0, self.vbuf.slice(..));
            p.set_index_buffer(self.ibuf.slice(..), wgpu::IndexFormat::Uint16);
            for k in 0..3 {
                p.set_bind_group(1, &self.vis_bg[k], &[]);
                p.draw_indexed_indirect(&self.args, k as u64 * 20);
            }
        }
        let read = self.frame % 20 == 0 && !self.busy.get();
        if read {
            enc.copy_buffer_to_buffer(&self.args, 0, &self.staging, 0, 60);
            if let Some(t) = &self.ts {
                enc.resolve_query_set(&t.qs, 0..4, &t.resolve, 0);
                enc.copy_buffer_to_buffer(&t.resolve, 0, &self.staging, 64, 32);
            }
        }
        self.queue.submit([enc.finish()]);
        self.queue.present(frame);
        if read {
            self.busy.set(true);
            let (busy, counts, st) = (self.busy.clone(), self.counts.clone(), self.staging.clone());
            let (gpu, period, has_ts) = (self.gpu.clone(), self.ts.as_ref().map_or(0.0, |t| t.period), self.ts.is_some());
            self.staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                if r.is_ok() {
                    let d = st.slice(..).get_mapped_range().unwrap();
                    let u: &[u32] = bytemuck::cast_slice(&d);
                    counts.set([u[1], u[6], u[11]]);
                    if has_ts {
                        let t: &[u64] = bytemuck::cast_slice(&d[64..96]);
                        let ms = |a: u64, b: u64| b.saturating_sub(a) as f32 * period * 1e-6;
                        gpu.set([ms(t[0], t[1]), ms(t[2], t[3])]);
                    }
                    drop(d);
                    st.unmap();
                }
                busy.set(false);
            });
        }
        self.frame += 1;
    }
}
