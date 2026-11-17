//! Personajes con huesos: animacion horneada en matrices por fotograma (ver `phoenix-bake --kind skin`).
//! Un draw por modelo con todas sus instancias; la GPU elige clip y fotograma por instancia.
use wgpu::util::DeviceExt;

pub const MAX_INSTANCES: u32 = 2048;

pub struct SkinSys {
    pub pl: wgpu::RenderPipeline,
    pub shadow_pl: wgpu::RenderPipeline,
    l: wgpu::BindGroupLayout,
    tex_l: wgpu::BindGroupLayout,
    samp: wgpu::Sampler,
}

pub struct SkinModel {
    bg: wgpu::BindGroup,
    tex_bg: wgpu::BindGroup,
    vb: wgpu::Buffer,
    ib: wgpu::Buffer,
    inst: wgpu::Buffer,
    n_idx: u32,
    pub count: u32,
}

impl SkinSys {
    pub fn new(
        device: &wgpu::Device, lux_wgsl: &str, draw_l: &wgpu::BindGroupLayout, gnd_l: &wgpu::BindGroupLayout,
        hdr: wgpu::TextureFormat, depth: wgpu::TextureFormat,
    ) -> Self {
        use wgpu::{BufferBindingType as B, ShaderStages as S};
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("skin"),
            source: wgpu::ShaderSource::Wgsl(format!("{}\n{}", lux_wgsl, include_str!("skin.wgsl")).into()),
        });
        let buf = |b: u32, ty: B, vis: S| wgpu::BindGroupLayoutEntry {
            binding: b, visibility: vis, count: None,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
        };
        let ro = B::Storage { read_only: true };
        let l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[buf(0, ro, S::VERTEX), buf(1, ro, S::VERTEX), buf(2, ro, S::VERTEX), buf(3, B::Uniform, S::VERTEX)],
        });
        let tex_l = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0, visibility: S::FRAGMENT, count: None,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
                    },
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1, visibility: S::FRAGMENT, count: None,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                },
            ],
        });
        let samp = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::Repeat, address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear, anisotropy_clamp: 4, ..Default::default()
        });
        let pl = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("skin"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None, bind_group_layouts: &[Some(draw_l), Some(&l), Some(&tex_l), Some(gnd_l)], immediate_size: 0,
            })),
            vertex: wgpu::VertexState {
                module: &module, entry_point: Some("vs"), compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 40,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 12, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 24, shader_location: 2 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Uint8x4, offset: 32, shader_location: 3 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Unorm8x4, offset: 36, shader_location: 4 },
                    ],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module, entry_point: Some("fs"), compilation_options: Default::default(),
                targets: &[Some(hdr.into())],
            }),
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: depth, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(), bias: Default::default(),
            }),
            multisample: Default::default(), multiview_mask: None, cache: None,
        });
        let attrs = [
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 12, shader_location: 1 },
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 24, shader_location: 2 },
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Uint8x4, offset: 32, shader_location: 3 },
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Unorm8x4, offset: 36, shader_location: 4 },
        ];
        let shadow_pl = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("skin-shadow"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None, bind_group_layouts: &[Some(draw_l), Some(&l)], immediate_size: 0,
            })),
            vertex: wgpu::VertexState {
                module: &module, entry_point: Some("vs_shadow"), compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: 40, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attrs })],
            },
            fragment: None,
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Front), ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: depth, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(), bias: wgpu::DepthBiasState { constant: 2, slope_scale: 2.0, clamp: 0.0 },
            }),
            multisample: Default::default(), multiview_mask: None, cache: None,
        });
        SkinSys { pl, shadow_pl, l, tex_l, samp }
    }

    /// Sube un modelo: vertices (40 B), indices u32, matrices por fotograma, clips `[primero, fotogramas, fps, dur]`
    /// y textura base RGBA8 con mips.
    #[allow(clippy::too_many_arguments)]
    pub fn add(
        &self, device: &wgpu::Device, queue: &wgpu::Queue, verts: &[u8], idx: &[u8], mats: &[u8], clips: &[f32],
        bones: u32, tex_size: u32, tex_mips: u32, tex: &[u8],
    ) -> SkinModel {
        let mk = |data: &[u8], usage| device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: data, usage });
        let vb = mk(verts, wgpu::BufferUsages::VERTEX);
        let ib = mk(idx, wgpu::BufferUsages::INDEX);
        let mb = mk(mats, wgpu::BufferUsages::STORAGE);
        let cb = mk(bytemuck::cast_slice(clips), wgpu::BufferUsages::STORAGE);
        let inst = device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: MAX_INSTANCES as u64 * 32, mapped_at_creation: false,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let ub = mk(bytemuck::cast_slice(&[bones as f32, 0.0, 0.0, 0.0]), wgpu::BufferUsages::UNIFORM);
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None, layout: &self.l,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: mb.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: cb.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: inst.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: ub.as_entire_binding() },
            ],
        });
        let t = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: tex_size, height: tex_size, depth_or_array_layers: 1 },
            mip_level_count: tex_mips, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[],
        });
        let (mut off, mut s) = (0usize, tex_size);
        for mip in 0..tex_mips {
            let bytes = (s * s * 4) as usize;
            queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &t, mip_level: mip, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                &tex[off..off + bytes],
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(s * 4), rows_per_image: Some(s) },
                wgpu::Extent3d { width: s, height: s, depth_or_array_layers: 1 },
            );
            off += bytes;
            s = (s / 2).max(1);
        }
        let view = t.create_view(&Default::default());
        let tex_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None, layout: &self.tex_l,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.samp) },
            ],
        });
        SkinModel { bg, tex_bg, vb, ib, inst, n_idx: (idx.len() / 4) as u32, count: 0 }
    }
}

impl SkinModel {
    /// 8 floats por instancia: `[x, y, z, escala, yaw, clip, tiempo, 0]`.
    pub fn set(&mut self, queue: &wgpu::Queue, data: &[f32]) {
        let n = ((data.len() / 8) as u32).min(MAX_INSTANCES);
        queue.write_buffer(&self.inst, 0, bytemuck::cast_slice(&data[..n as usize * 8]));
        self.count = n;
    }

    /// Profundidad de los personajes en una vista de sombras (`view_bg` = globals de esa vista).
    pub fn draw_shadow<'a>(&'a self, p: &mut wgpu::RenderPass<'a>, pl: &'a wgpu::RenderPipeline, view_bg: &'a wgpu::BindGroup) {
        if self.count == 0 {
            return;
        }
        p.set_pipeline(pl);
        p.set_bind_group(0, view_bg, &[]);
        p.set_bind_group(1, &self.bg, &[]);
        p.set_vertex_buffer(0, self.vb.slice(..));
        p.set_index_buffer(self.ib.slice(..), wgpu::IndexFormat::Uint32);
        p.draw_indexed(0..self.n_idx, 0, 0..self.count);
    }

    pub fn draw<'a>(&'a self, p: &mut wgpu::RenderPass<'a>, pl: &'a wgpu::RenderPipeline, draw_bg: &'a wgpu::BindGroup, gnd_bg: &'a wgpu::BindGroup) {
        if self.count == 0 {
            return;
        }
        p.set_pipeline(pl);
        p.set_bind_group(0, draw_bg, &[]);
        p.set_bind_group(1, &self.bg, &[]);
        p.set_bind_group(2, &self.tex_bg, &[]);
        p.set_bind_group(3, gnd_bg, &[]);
        p.set_vertex_buffer(0, self.vb.slice(..));
        p.set_index_buffer(self.ib.slice(..), wgpu::IndexFormat::Uint32);
        p.draw_indexed(0..self.n_idx, 0, 0..self.count);
    }
}
