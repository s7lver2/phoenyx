// Formas de colision y su caja envolvente. Todo en f32, sin asignaciones.

pub type V3 = [f32; 3];

/// Una forma tal como la ven las consultas (las celdas sólidas salen como cajas).
#[derive(Clone, Copy, Debug)]
pub enum Shape {
    /// Caja alineada con los ejes.
    Box { min: V3, max: V3 },
    /// Caja girada en Y: centro, medias medidas locales y giro (rad).
    BoxY { c: V3, half: V3, yaw: f32 },
    /// Cilindro vertical: centro de la base, radio y alto.
    Cyl { c: V3, r: f32, h: f32 },
}

impl Shape {
    /// Caja envolvente (min, max).
    pub fn aabb(&self) -> (V3, V3) {
        match *self {
            Shape::Box { min, max } => (min, max),
            Shape::BoxY { c, half, yaw } => {
                let (s, k) = (yaw.sin().abs(), yaw.cos().abs());
                let ex = half[0] * k + half[2] * s;
                let ez = half[0] * s + half[2] * k;
                ([c[0] - ex, c[1] - half[1], c[2] - ez], [c[0] + ex, c[1] + half[1], c[2] + ez])
            }
            Shape::Cyl { c, r, h } => ([c[0] - r, c[1], c[2] - r], [c[0] + r, c[1] + h, c[2] + r]),
        }
    }
}
