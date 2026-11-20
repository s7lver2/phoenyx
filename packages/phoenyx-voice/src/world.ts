/*
 * Lo que la voz necesita saber del mundo. El motor (o el juego) implementa `VoiceWorld`; la librería no sabe de mallas ni de niveles.
 */
export type Vec3 = readonly [number, number, number];

export interface VoiceWorld {
  /** Obstáculos entre dos puntos: cuántas paredes se cruzan y, opcional, su grosor total (m). */
  raycast(a: Vec3, b: Vec3): { walls: number; thickness?: number };
  /** Volumen aproximado (m³) de la sala en ese punto: decide la reverb. Sin él se usa la del preajuste. */
  roomSize?(p: Vec3): number;
}

/**
 * Un `VoiceWorld` para mundos en cuadrícula (laberintos, hoteles): `open[y * w + x]` es 1 en el suelo y 0 en la pared; `cell` es el lado de una celda (m).
 * El rayo cruza la cuadrícula (DDA) y cuenta las paredes distintas que atraviesa. La sala: el volumen de la zona abierta alrededor (hasta `reach` celdas).
 */
export function gridWorld(g: { open: ArrayLike<number>; w: number; h: number; cell: number; ceil?: number; reach?: number; offsetX?: number; offsetZ?: number }): VoiceWorld {
  const { open, w, h, cell } = g,
    ox = g.offsetX ?? 0,
    oz = g.offsetZ ?? 0,
    ceil = g.ceil ?? 3,
    reach = g.reach ?? 6;
  const solid = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || !open[y * w + x];
  return {
    raycast(a, b) {
      let x = Math.floor((a[0] - ox) / cell),
        y = Math.floor((a[2] - oz) / cell);
      const x1 = Math.floor((b[0] - ox) / cell),
        y1 = Math.floor((b[2] - oz) / cell),
        dx = (b[0] - a[0]) / cell,
        dy = (b[2] - a[2]) / cell,
        sx = Math.sign(dx),
        sy = Math.sign(dy);
      let walls = 0,
        inWall = solid(x, y);
      // DDA: cuántas veces se pasa de aire a pared (una pared gruesa cuenta una vez)
      const tdx = dx ? Math.abs(1 / dx) : Infinity,
        tdy = dy ? Math.abs(1 / dy) : Infinity;
      let tx = dx ? ((sx > 0 ? x + 1 : x) - (a[0] - ox) / cell) / dx : Infinity,
        ty = dy ? ((sy > 0 ? y + 1 : y) - (a[2] - oz) / cell) / dy : Infinity;
      for (let n = 0; n < 4096 && (x !== x1 || y !== y1); n++) {
        if (tx < ty) ((x += sx), (tx += tdx));
        else ((y += sy), (ty += tdy));
        const s = solid(x, y);
        if (s && !inWall) walls++;
        inWall = s;
      }
      return { walls, thickness: walls * 0.2 };
    },
    roomSize(p) {
      const cx = Math.floor((p[0] - ox) / cell),
        cy = Math.floor((p[2] - oz) / cell);
      let free = 0;
      for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) if (!solid(cx + i, cy + j)) free++;
      return free * cell * cell * ceil;
    },
  };
}
