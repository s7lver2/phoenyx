//! Lux: iluminacion en GPU para wgpu/WebGPU.
//!
//! - PBR Cook-Torrance (GGX) con sol, luna y ambiente segun la hora del dia.
//! - Sol con sombras en 2 cascadas (PCF con disco rotado, mezcla entre cascadas, bias por pendiente).
//! - Luces puntuales, focos y tubos fluorescentes (hasta 512) con culling por clusters en compute.
//!
//! Lux no dibuja la escena: aporta el WGSL (`WGSL`), los recursos de GPU (`Lux`) y el calculo de
//! las cascadas (`Lux::fit_cascades`). El motor anfitrion renderiza cada cascada en la capa
//! `Lux::layer(i)` con la matriz devuelta y enlaza `Lux::bind_entries` en el grupo 3 (bindings 3..=7).
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

/// Codigo WGSL de la iluminacion; se antepone al shader del motor (ver el contrato en el archivo).
pub const WGSL: &str = include_str!("lux.wgsl");
pub const SHADOW_RES: u32 = 2048;
pub const MAX_LIGHTS: u32 = 512;
pub const CLUSTERS: u32 = 16 * 9 * 24;
/// Radios (m) de las dos cascadas del sol, alrededor de la camara.
pub const CASCADES: [f32; 2] = [25.0, 130.0];
/// Focos con sombra a la vez (los mas cercanos a la camara); usan las capas 2..=5.
pub const MAX_SHADOW_SPOTS: usize = 4;
pub const SHADOW_LAYERS: u32 = 2 + MAX_SHADOW_SPOTS as u32;
/// Floats por luz en `Lux::set_lights`.
pub const LIGHT_STRIDE: usize = 16;

/// Tipos de luz. Formato de cada luz (16 floats):
/// `[x, y, z, radio, r, g, b, intensidad, tipo, dx, dy, dz, cono_grados, largo_tubo, 0, 0]`
/// tipo 0 = puntual, 1 = foco (dir + semiangulo del cono), 2 = tubo (eje + largo, centrado en xyz).
pub const POINT: f32 = 0.0;
pub const SPOT: f32 = 1.0;
pub const TUBE: f32 = 2.0;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ShU {
    vp: [[f32; 16]; 2],
    split: [f32; 4],
    sun: [f32; 4],
    texel: [f32; 4],
    moon_dir: [f32; 4],
    moon_rad: [f32; 4],
    ambient: [f32; 4],
    spot_vp: [[f32; 16]; MAX_SHADOW_SPOTS],
}

/// Un foco con sombra para este frame: el anfitrion renderiza la escena con `view_proj` en la capa `2 + slot`.
pub struct SpotShadow {
    pub slot: usize,
    pub view_proj: Mat4,
    pub pos: Vec3,
    /// Campo de vision vertical (rad), para el factor de pixeles del LOD.
    pub fov: f32,
    pub radius: f32,
}

struct Eligible {
    index: usize,
    pos: Vec3,
    dir: Vec3,
    cone: f32,
    radius: f32,
}

/// Una cascada de sombras: camara ortografica alineada a la luz y ajustada al texel.
pub struct Cascade {
    pub view_proj: Mat4,
    pub radius: f32,
    pub texel: f32,
}

pub struct Lux {
    lights: wgpu::Buffer,
    clusters: wgpu::Buffer,
    uniform: wgpu::Buffer,
    array_view: wgpu::TextureView,
    layers: Vec<wgpu::TextureView>,
    cmp: wgpu::Sampler,
    pub n_lights: u32,
    pub sun_dir: Vec3,
    /// rgb = radiancia del sol; w = escala del ambiente.
    pub sun: [f32; 4],
    pub moon_dir: Vec3,
    pub moon: [f32; 3],
    pub exposure: f32,
    pub shadows: bool,
    /// Ambiente plano (interiores): sustituye al ambiente por hora si es Some.
    pub flat_ambient: Option<[f32; 3]>,
    eligible: Vec<Eligible>,
    assigned: [Option<usize>; MAX_SHADOW_SPOTS],
}

/// Planos del frustum (normalizados) de una matriz vista-proyeccion con profundidad 0..1.
pub fn planes_of(vp: Mat4) -> [[f32; 4]; 6] {
    let m = vp.transpose();
    let (r0, r1, r2, r3) = (m.col(0), m.col(1), m.col(2), m.col(3));
    [r3 + r0, r3 - r0, r3 + r1, r3 - r1, r2, r3 - r2].map(|p| {
        let l = p.truncate().length();
        (p / l).to_array()
    })
}

fn dir_of(az: f32, el: f32) -> Vec3 {
    Vec3::new(el.cos() * az.sin(), el.sin(), -el.cos() * az.cos()).normalize()
}

impl Lux {
    pub fn new(device: &wgpu::Device) -> Lux {
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("lux-shadow"),
            size: wgpu::Extent3d { width: SHADOW_RES, height: SHADOW_RES, depth_or_array_layers: SHADOW_LAYERS },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let array_view = tex.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default()
        });
        let layers = (0..SHADOW_LAYERS)
            .map(|i| tex.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2), base_array_layer: i, array_layer_count: Some(1),
                ..Default::default()
            }))
            .collect();
        let cmp = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
            compare: Some(wgpu::CompareFunction::LessEqual), ..Default::default()
        });
        let buf = |size: u64, usage| device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size, mapped_at_creation: false, usage,
        });
        Lux {
            lights: buf((MAX_LIGHTS * 48) as u64, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST),
            clusters: buf((CLUSTERS * 32 * 4) as u64, wgpu::BufferUsages::STORAGE),
            uniform: buf(size_of::<ShU>() as u64, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST),
            array_view, layers, cmp,
            n_lights: 0,
            sun_dir: Vec3::new(-0.7, 0.55, -0.25).normalize(),
            sun: [2.4, 2.2, 1.92, 0.9],
            moon_dir: Vec3::new(0.3, 0.7, 0.4).normalize(),
            moon: [0.0; 3],
            exposure: 1.0,
            shadows: true,
            flat_ambient: None,
            eligible: vec![],
            assigned: [None; MAX_SHADOW_SPOTS],
        }
    }

    /// Entradas del layout del grupo de bind (bindings 3..=7): sombras, sampler de comparacion,
    /// uniforme, luces y clusters.
    pub fn layout_entries() -> Vec<wgpu::BindGroupLayoutEntry> {
        use wgpu::{BindingType as T, BufferBindingType as B, ShaderStages as S};
        let buf = |binding, ty, vis| wgpu::BindGroupLayoutEntry {
            binding, visibility: vis, count: None,
            ty: T::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
        };
        vec![
            wgpu::BindGroupLayoutEntry {
                binding: 3, visibility: S::FRAGMENT, count: None,
                ty: T::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2Array,
                    multisampled: false,
                },
            },
            wgpu::BindGroupLayoutEntry {
                binding: 4, visibility: S::FRAGMENT, count: None,
                ty: T::Sampler(wgpu::SamplerBindingType::Comparison),
            },
            buf(5, B::Uniform, S::FRAGMENT),
            buf(6, B::Storage { read_only: true }, S::FRAGMENT | S::COMPUTE),
            buf(7, B::Storage { read_only: false }, S::FRAGMENT | S::COMPUTE),
        ]
    }

    pub fn bind_entries(&self) -> Vec<wgpu::BindGroupEntry<'_>> {
        vec![
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&self.array_view) },
            wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.cmp) },
            wgpu::BindGroupEntry { binding: 5, resource: self.uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: self.lights.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 7, resource: self.clusters.as_entire_binding() },
        ]
    }

    /// Capa de la textura de sombras donde el anfitrion renderiza la cascada `i`.
    pub fn layer(&self, i: usize) -> &wgpu::TextureView {
        &self.layers[i]
    }

    /// Sube las luces (formato en `LIGHT_STRIDE`); el culling y el sombreado ocurren en la GPU.
    pub fn set_lights(&mut self, queue: &wgpu::Queue, data: &[f32]) {
        let n = ((data.len() / LIGHT_STRIDE) as u32).min(MAX_LIGHTS);
        let mut v = Vec::with_capacity(n as usize * 12);
        self.eligible.clear();
        self.assigned = [None; MAX_SHADOW_SPOTS];
        for (index, l) in data.chunks_exact(LIGHT_STRIDE).take(n as usize).enumerate() {
            if l[8] == SPOT && l[14] > 0.5 {
                self.eligible.push(Eligible {
                    index, pos: Vec3::new(l[0], l[1], l[2]), dir: Vec3::new(l[9], l[10], l[11]).normalize_or_zero(),
                    cone: l[12].to_radians(), radius: l[3],
                });
            }
            let k = l[7];
            let (kind, d) = (l[8], Vec3::new(l[9], l[10], l[11]).normalize_or_zero());
            let c = if kind == SPOT {
                [d.x, d.y, d.z, l[12].to_radians().cos()]
            } else if kind == TUBE {
                [d.x, d.y, d.z, l[13] * 0.5]
            } else {
                [0.0; 4]
            };
            v.extend_from_slice(&[l[0], l[1], l[2], l[3], l[4] * k, l[5] * k, l[6] * k, kind]);
            v.extend_from_slice(&c);
        }
        queue.write_buffer(&self.lights, 0, bytemuck::cast_slice(&v));
        self.n_lights = n;
    }

    /// Elige los focos con sombra mas cercanos a la camara (los marcados con `l[14] = 1`) y devuelve
    /// sus vistas. Cambia en el buffer de luces solo el tipo de las que ganan o pierden el slot.
    pub fn update_shadow_spots(&mut self, queue: &wgpu::Queue, eye: Vec3) -> Vec<SpotShadow> {
        let mut near: Vec<(f32, usize)> = self.eligible.iter().enumerate()
            .map(|(k, e)| (e.pos.distance(eye), k))
            .filter(|(d, k)| *d < self.eligible[*k].radius + 8.0)
            .collect();
        near.sort_by(|a, b| a.0.total_cmp(&b.0));
        near.truncate(MAX_SHADOW_SPOTS);
        let mut want: [Option<usize>; MAX_SHADOW_SPOTS] = [None; MAX_SHADOW_SPOTS];
        // Conserva el slot de los que ya lo tenian; los nuevos ocupan los libres.
        for &(_, k) in &near {
            if let Some(s) = self.assigned.iter().position(|a| *a == Some(k)) { want[s] = Some(k); }
        }
        for &(_, k) in &near {
            if !want.contains(&Some(k)) {
                if let Some(s) = want.iter().position(|a| a.is_none()) { want[s] = Some(k); }
            }
        }
        let write = |li: usize, kind: f32| queue.write_buffer(&self.lights, li as u64 * 48 + 28, bytemuck::bytes_of(&kind));
        for s in 0..MAX_SHADOW_SPOTS {
            if self.assigned[s] != want[s] {
                if let Some(k) = self.assigned[s] { if !want.contains(&Some(k)) { write(self.eligible[k].index, SPOT); } }
                if let Some(k) = want[s] { write(self.eligible[k].index, 11.0 + s as f32); }
            }
        }
        self.assigned = want;
        want.iter().enumerate().filter_map(|(slot, k)| {
            let e = &self.eligible[(*k)?];
            let fov = (e.cone * 2.0 + 0.12).min(2.6);
            let up = if e.dir.y.abs() > 0.99 { Vec3::X } else { Vec3::Y };
            let vp = Mat4::perspective_rh(fov, 1.0, 0.1, e.radius) * Mat4::look_to_rh(e.pos, e.dir, up);
            Some(SpotShadow { slot, view_proj: vp, pos: e.pos, fov, radius: e.radius })
        }).collect()
    }

    pub fn set_sun_dir(&mut self, az: f32, el: f32) {
        self.sun_dir = dir_of(az, el.clamp(-0.5, 1.53));
    }

    pub fn set_moon(&mut self, az: f32, el: f32, rgb: [f32; 3]) {
        self.moon_dir = dir_of(az, el.clamp(0.05, 1.53));
        self.moon = rgb;
    }

    /// Hay sombras del sol en este frame (activadas y con el sol sobre el horizonte).
    pub fn shadows_active(&self) -> bool {
        self.shadows && self.sun_dir.y > 0.03
    }

    /// Workgroups del compute `cluster_cull`.
    pub fn cluster_groups() -> u32 {
        CLUSTERS.div_ceil(64)
    }

    /// Ajusta las cascadas a la camara: cajas ortograficas alineadas a la luz y al texel.
    pub fn fit_cascades(&self, eye: Vec3, forward: Vec3) -> [Cascade; 2] {
        let lview = Mat4::look_to_rh(Vec3::ZERO, -self.sun_dir, Vec3::Y);
        CASCADES.map(|rr| {
            let c = lview.transform_point3(eye + forward * rr * 0.5);
            let texel = 2.0 * rr / SHADOW_RES as f32;
            let (cx, cy) = ((c.x / texel).floor() * texel, (c.y / texel).floor() * texel);
            let proj = Mat4::orthographic_rh(cx - rr, cx + rr, cy - rr, cy + rr, -c.z - 300.0, -c.z + rr * 1.3);
            Cascade { view_proj: proj * lview, radius: rr, texel }
        })
    }

    /// Escribe el uniforme de iluminacion; `cascades` = None desactiva las sombras.
    pub fn write_uniform(&self, queue: &wgpu::Queue, cascades: Option<&[Cascade; 2]>, spots: &[SpotShadow]) {
        let mut u = ShU::zeroed();
        u.sun = self.sun;
        u.texel[3] = self.exposure;
        u.moon_dir = [self.moon_dir.x, self.moon_dir.y, self.moon_dir.z, 0.0];
        u.moon_rad = [self.moon[0], self.moon[1], self.moon[2], 0.0];
        if let Some(a) = self.flat_ambient { u.ambient = [a[0], a[1], a[2], 1.0]; }
        for s in spots { u.spot_vp[s.slot] = s.view_proj.to_cols_array(); }
        if !spots.is_empty() { u.texel[2] = 1.0 / SHADOW_RES as f32; }
        if let Some(c) = cascades {
            for i in 0..2 {
                u.vp[i] = c[i].view_proj.to_cols_array();
                u.texel[i] = c[i].texel;
            }
            u.split = [CASCADES[0] * 1.2, CASCADES[1] * 1.2, 0.0, 1.0];
            u.texel[2] = 1.0 / SHADOW_RES as f32;
        }
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&u));
    }
}
