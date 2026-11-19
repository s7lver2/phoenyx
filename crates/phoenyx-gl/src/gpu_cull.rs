// Culling y LOD en GPU de las mallas instanciadas marcadas (ver gpu_cull.wgsl y docs/superpowers/plans/2026-11-19-fusion-phoenix.md, tarea 2).
// El compute rellena, por (grupo, LOD), la lista de instancias visibles y el `instance_count` de sus argumentos indirectos;
// el dibujo lo hace el sombreado de Phoenyx (`vs` remapea la instancia con `gpu_vis`).
use bytemuck::{Pod, Zeroable};

/// Un grupo para el compute (80 bytes, igual que `Group` en gpu_cull.wgsl).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
pub struct GroupGpu {
    pub a: [u32; 4],
    pub b: [f32; 4],
    pub err: [f32; 4],
    pub vis: [u32; 4],
    pub slot: [u32; 4],
}

pub struct GpuCull {
    pipeline: wgpu::ComputePipeline,
    bgl: wgpu::BindGroupLayout,
    params: wgpu::Buffer,
    groups: wgpu::Buffer,
    groups_cap: u64,
    pub args: wgpu::Buffer,
    args_cap: u64,
}

fn storage(device: &wgpu::Device, size: u64, extra: wgpu::BufferUsages) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: size.max(16),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | extra,
        mapped_at_creation: false,
    })
}

impl GpuCull {
    pub fn new(device: &wgpu::Device) -> GpuCull {
        use wgpu::{BufferBindingType as B, ShaderStages as S};
        let e = |binding: u32, ty: B| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: S::COMPUTE,
            count: None,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
        };
        let ro = B::Storage { read_only: true };
        let rw = B::Storage { read_only: false };
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[e(0, B::Uniform), e(1, ro), e(2, ro), e(3, ro), e(4, rw), e(5, rw), e(6, B::Uniform)],
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(include_str!("gpu_cull.wgsl").into()) });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&bgl)], immediate_size: 0 })),
            module: &module,
            entry_point: Some("cull"),
            compilation_options: Default::default(),
            cache: None,
        });
        let params = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        GpuCull {
            pipeline,
            bgl,
            params,
            groups: storage(device, 1024, wgpu::BufferUsages::empty()),
            groups_cap: 1024,
            args: storage(device, 1024, wgpu::BufferUsages::INDIRECT),
            args_cap: 1024,
        }
    }

    /// Sube grupos, argumentos indirectos (5 u32 por plaza, con `instance_count` a 0) y parametros `[tolerancia px, alto px, diametro minimo px, 0]`.
    pub fn upload(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, groups: &[GroupGpu], args: &[u32], params: [f32; 4]) {
        let gb: &[u8] = bytemuck::cast_slice(groups);
        if gb.len() as u64 > self.groups_cap {
            self.groups_cap = (gb.len() as u64).next_power_of_two();
            self.groups = storage(device, self.groups_cap, wgpu::BufferUsages::empty());
        }
        queue.write_buffer(&self.groups, 0, gb);
        let ab: &[u8] = bytemuck::cast_slice(args);
        if ab.len() as u64 > self.args_cap {
            self.args_cap = (ab.len() as u64).next_power_of_two();
            self.args = storage(device, self.args_cap, wgpu::BufferUsages::INDIRECT);
        }
        queue.write_buffer(&self.args, 0, ab);
        queue.write_buffer(&self.params, 0, bytemuck::cast_slice(&params));
    }

    /// Graba el compute: un workgroup de 64 instancias por columna y un grupo por fila.
    pub fn encode(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, globals: &wgpu::Buffer, objects: &wgpu::Buffer, inst_mats: &wgpu::Buffer, vis: &wgpu::Buffer, ngroups: u32, max_count: u32) {
        fn b(binding: u32, buf: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry { binding, resource: buf.as_entire_binding() }
        }
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.bgl,
            entries: &[b(0, globals), b(1, objects), b(2, inst_mats), b(3, &self.groups), b(4, &self.args), b(5, vis), b(6, &self.params)],
        });
        let mut p = enc.begin_compute_pass(&Default::default());
        p.set_pipeline(&self.pipeline);
        p.set_bind_group(0, &bg, &[]);
        p.dispatch_workgroups(max_count.div_ceil(64).max(1), ngroups, 1);
    }
}
