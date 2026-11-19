// Colisiones cinematicas de Phoenyx (crates/phoenyx-collide): jugador/entidades, proyectiles con rebote y raycast.
// Hay que crearlo cuando el WASM ya esta cargado (despues de `renderer.ready`).
import { Collide } from '../pkg/phoenyx_gl.js';

export const HIT_WALL = 1;
export const GROUNDED = 2;
export const STEPPED = 4;

/** Un cuerpo de personaje: los pies en (x, y, z), cilindro de radio y alto dados. Los campos son la vista de un Float32Array que se reutiliza. */
export class Body {
  readonly a = new Float32Array(8);
  constructor(x = 0, y = 0, z = 0, r = 0.3, h = 1.8, stepMax = 0.35, ground = true) {
    this.a.set([x, y, z, r, h, stepMax, 0, ground ? 1 : 0]);
  }
  get x() { return this.a[0]; }
  get y() { return this.a[1]; }
  get z() { return this.a[2]; }
  set x(v: number) { this.a[0] = v; }
  set y(v: number) { this.a[1] = v; }
  set z(v: number) { this.a[2] = v; }
  get velY() { return this.a[6]; }
  set velY(v: number) { this.a[6] = v; }
  get ground() { return this.a[7] > 0.5; }
  set ground(v: boolean) { this.a[7] = v ? 1 : 0; }
}

/** Proyectiles en un buffer plano (12 floats cada uno), sin objetos por proyectil. */
export class Projectiles {
  readonly buf: Float32Array;
  n = 0;
  constructor(readonly capacity = 64) {
    this.buf = new Float32Array(capacity * 12);
  }
  /** Añade uno; devuelve su indice, o -1 si no cabe. */
  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, r = 0.1, restitution = 0.5, friction = 0.2): number {
    if (this.n >= this.capacity) return -1;
    this.buf.set([x, y, z, vx, vy, vz, r, restitution, friction, 1, 0, 0], this.n * 12);
    return this.n++;
  }
  pos(i: number): [number, number, number] { return [this.buf[i * 12], this.buf[i * 12 + 1], this.buf[i * 12 + 2]]; }
  vel(i: number): [number, number, number] { return [this.buf[i * 12 + 3], this.buf[i * 12 + 4], this.buf[i * 12 + 5]]; }
  alive(i: number) { return this.buf[i * 12 + 9] > 0.5; }
  resting(i: number) { return this.buf[i * 12 + 10] > 0.5; }
  clear() { this.n = 0; }
}

export class CollisionWorld {
  private w: Collide;
  private hit = new Float32Array(4);
  constructor(cell = 3) {
    this.w = new Collide(cell);
  }
  addBox(chunk: number, min: [number, number, number], max: [number, number, number]) { this.w.add_box(chunk, ...min, ...max); }
  addBoxY(chunk: number, c: [number, number, number], half: [number, number, number], yaw: number) { this.w.add_box_y(chunk, ...c, ...half, yaw); }
  addCylinder(chunk: number, x: number, y: number, z: number, r: number, h: number) { this.w.add_cylinder(chunk, x, y, z, r, h); }
  /** Celdas solidas del laberinto: `bits` por filas, 1 bit por celda (LSB primero). */
  addCells(chunk: number, ox: number, oz: number, cell: number, w: number, h: number, bits: Uint8Array, y0: number, y1: number) { this.w.add_cells(chunk, ox, oz, cell, w, h, bits, y0, y1); }
  addFloor(chunk: number, x0: number, z0: number, x1: number, z1: number, y: number) { this.w.add_floor(chunk, x0, z0, x1, z1, y); }
  addRamp(chunk: number, x0: number, z0: number, x1: number, z1: number, ya: number, yb: number, axis: 0 | 1) { this.w.add_ramp(chunk, x0, z0, x1, z1, ya, yb, axis); }
  addSteps(chunk: number, x0: number, z0: number, x1: number, z1: number, y0: number, rise: number, tread: number, count: number, axis: 0 | 1, fromMax = false) { this.w.add_steps(chunk, x0, z0, x1, z1, y0, rise, tread, count, axis, fromMax); }
  removeChunk(chunk: number) { this.w.remove_chunk(chunk); }

  /** Mueve el cuerpo (dx, dz) y avanza su vertical dt (gravedad positiva hacia abajo). Devuelve banderas HIT_WALL | GROUNDED | STEPPED. */
  move(b: Body, dx: number, dz: number, dt: number, gravity: number): number { return this.w.move_body(b.a, dx, dz, dt, gravity); }
  /** Solo XZ con contactos (quien lleva su propia vertical). */
  moveXZ(b: Body, dx: number, dz: number): number { return this.w.move_xz(b.a, dx, dz); }
  /** Altura del suelo bajo (x, z) para unos pies a `feet`; null si no hay. */
  floorAt(x: number, z: number, feet: number, stepMax = 0.35): number | null {
    const h = this.w.floor_at(x, z, feet, stepMax);
    return Number.isNaN(h) ? null : h;
  }
  /** Primer impacto del rayo (direccion unitaria): distancia y normal, o null. */
  raycast(o: [number, number, number], d: [number, number, number], max: number): { t: number; normal: [number, number, number] } | null {
    return this.w.raycast(...o, ...d, max, this.hit) ? { t: this.hit[0], normal: [this.hit[1], this.hit[2], this.hit[3]] } : null;
  }
  step(p: Projectiles, dt: number, gravity: number) { this.w.step_projectiles(p.buf, p.n, dt, gravity); }
  dispose() { this.w.free(); }
}
