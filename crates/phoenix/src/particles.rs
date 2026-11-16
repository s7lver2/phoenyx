//! Particulas en GPU: transparentes, sin estado ni compute. La CPU solo escribe los nacimientos
//! (un `write_buffer` por emision) y el vertex shader calcula posicion, tamano y fundido por edad.
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PU {
    pub vp: [f32; 16],
    pub right: [f32; 4],
    pub up: [f32; 4],
    pub time: [f32; 4],
}

pub struct Particles {
    pub pl: wgpu::RenderPipeline,
    pub bg: wgpu::BindGroup,
    pub uni: wgpu::Buffer,
    buf: wgpu::Buffer,
    capacity: u32,
    head: u32,
    pub live: u32,
    seed: u32,
}

impl Particles {
    pub fn new(device: &wgpu::Device, hdr: wgpu::TextureFormat, depth: wgpu::TextureFormat, capacity: u32) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("particles"),
            source: wgpu::ShaderSource::Wgsl(include_str!("particles.wgsl").into()),
        });
        let uni = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: std::mem::size_of::<PU>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: &vec![0u8; capacity as usize * 64],
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let e = |b: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding: b,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[e(0, wgpu::BufferBindingType::Uniform), e(1, wgpu::BufferBindingType::Storage { read_only: true })],
        });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &l,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uni.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: buf.as_entire_binding() },
            ],
        });
        let c = wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        };
        let pl = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("particles"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[Some(&l)],
                immediate_size: 0,
            })),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: hdr,
                    blend: Some(wgpu::BlendState { color: c, alpha: c }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: depth,
                depth_write_enabled: Some(false),
                depth_compare: Some(wgpu::CompareFunction::LessEqual),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        Particles { pl, bg, uni, buf, capacity, head: 0, live: 0, seed: 0x9E3779B9 }
    }

    fn rnd(&mut self) -> f32 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 17;
        self.seed ^= self.seed << 5;
        (self.seed >> 8) as f32 / 16777216.0
    }

    /// `p` = [x, y, z, vx, vy, vz, dispersion, variacion de velocidad, vida, tam0, tam1, gravedad, r, g, b, a, aditivo].
    pub fn emit(&mut self, queue: &wgpu::Queue, now: f32, p: &[f32], count: u32) {
        if p.len() < 17 || count == 0 {
            return;
        }
        let count = count.min(self.capacity);
        let mut data: Vec<f32> = Vec::with_capacity(count as usize * 16);
        for _ in 0..count {
            let d = [self.rnd() * 2.0 - 1.0, self.rnd() * 2.0 - 1.0, self.rnd() * 2.0 - 1.0];
            let k = 1.0 + (self.rnd() * 2.0 - 1.0) * p[7];
            let life = p[8] * (0.7 + self.rnd() * 0.6);
            data.extend_from_slice(&[p[0], p[1], p[2], now]);
            data.extend_from_slice(&[(p[3] + d[0] * p[6]) * k, (p[4] + d[1] * p[6]) * k, (p[5] + d[2] * p[6]) * k, life]);
            data.extend_from_slice(&[p[12], p[13], p[14], p[15]]);
            data.extend_from_slice(&[p[9], p[10], p[11], if p[16] > 0.5 { 1.0 } else { 0.0 }]);
        }
        // Buffer circular: si la emision cruza el final, se parte en dos escrituras.
        let first = count.min(self.capacity - self.head);
        let bytes: &[u8] = bytemuck::cast_slice(&data);
        queue.write_buffer(&self.buf, self.head as u64 * 64, &bytes[..first as usize * 64]);
        if first < count {
            queue.write_buffer(&self.buf, 0, &bytes[first as usize * 64..]);
        }
        self.head = (self.head + count) % self.capacity;
        self.live = (self.live + count).min(self.capacity);
    }
}
