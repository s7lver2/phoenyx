// Rejilla hash uniforme en XZ: cada celda tiene una lista enlazada de colisionadores en una arena (sin `Vec` por celda).
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Hasher multiplicativo (las claves son enteros empaquetados: no hace falta SipHash).
#[derive(Default)]
pub struct Fx(u64);
impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, b: &[u8]) {
        for &x in b {
            self.0 = (self.0.rotate_left(5) ^ x as u64).wrapping_mul(0x517c_c1b7_2722_0a95);
        }
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = (v ^ (v >> 29)).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
}

pub const NIL: u32 = u32::MAX;

struct Node {
    col: u32,
    next: u32,
}

pub struct Grid {
    pub cell: f32,
    inv: f32,
    heads: HashMap<u64, u32, BuildHasherDefault<Fx>>,
    nodes: Vec<Node>,
}

#[inline]
pub fn key(cx: i32, cz: i32) -> u64 {
    ((cx as u32 as u64) << 32) | cz as u32 as u64
}

impl Grid {
    pub fn new(cell: f32) -> Grid {
        Grid { cell, inv: 1.0 / cell, heads: HashMap::default(), nodes: Vec::new() }
    }

    #[inline]
    pub fn coord(&self, v: f32) -> i32 {
        (v * self.inv).floor() as i32
    }

    /// Inserta `col` en todas las celdas que toca la caja XZ (min, max).
    pub fn insert(&mut self, col: u32, min: [f32; 2], max: [f32; 2]) {
        let (x0, x1, z0, z1) = (self.coord(min[0]), self.coord(max[0]), self.coord(min[1]), self.coord(max[1]));
        for cz in z0..=z1 {
            for cx in x0..=x1 {
                let head = self.heads.entry(key(cx, cz)).or_insert(NIL);
                self.nodes.push(Node { col, next: *head });
                *head = (self.nodes.len() - 1) as u32;
            }
        }
    }

    /// Recorre los colisionadores de las celdas de la caja XZ (pueden repetirse: quien llama los deduplica).
    pub fn visit(&self, min: [f32; 2], max: [f32; 2], mut f: impl FnMut(u32)) {
        let (x0, x1, z0, z1) = (self.coord(min[0]), self.coord(max[0]), self.coord(min[1]), self.coord(max[1]));
        for cz in z0..=z1 {
            for cx in x0..=x1 {
                let mut n = self.heads.get(&key(cx, cz)).copied().unwrap_or(NIL);
                while n != NIL {
                    let nd = &self.nodes[n as usize];
                    f(nd.col);
                    n = nd.next;
                }
            }
        }
    }

    pub fn clear(&mut self) {
        self.heads.clear();
        self.nodes.clear();
    }
}
