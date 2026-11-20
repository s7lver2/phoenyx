/*
 * La voz en el espacio. Por cada emisor un tramo propio: atenuación por distancia -> filtro de oclusión -> panner (HRTF o estéreo) -> salida,
 * más un envío a un bus común de reverb cuya cola sale del tamaño de la sala. El juego dice dónde está cada uno (`setEmitter`) y la librería
 * pregunta al mundo (`VoiceWorld`) por las paredes entre emisor y oyente.
 *
 * Perfiles (`quality`):
 *   off    sin espacio: todos se oyen igual y centrados
 *   low    distancia + balance estéreo, sin reverb ni oclusión
 *   medium distancia + HRTF + reverb del preajuste
 *   high   todo: HRTF, oclusión por paredes, reverb según la sala medida, transmisión por grosor
 */
import type { Vec3, VoiceWorld } from './world';

export type SpatialQuality = 'off' | 'low' | 'medium' | 'high';

export interface SpatialConfig {
  quality: SpatialQuality;
  /** Hasta esta distancia (m) se oye entera. */
  near: number;
  /** A partir de aquí (m) no se oye. */
  far: number;
  /** Curva de caída entre near y far (1 = lineal; mayor = cae antes). */
  rolloff: number;
  /** Cada pared: cuánto baja el volumen (0-1 multiplicador) y a qué frecuencia (Hz) se apaga la voz. */
  wallGain: number;
  wallCutoff: number;
  /** Tope de paredes que cuentan (más allá no se oye cambio). */
  maxWalls: number;
  /** Reverb del preajuste cuando no hay medida de la sala: mezcla (0-1), cola (s) y brillo (Hz). */
  reverb: { wet: number; decay: number; lp: number };
  /** Cuántas veces por segundo se recalcula la oclusión (los rayos son lo caro). */
  occlusionHz: number;
  /** Cuántos emisores (los más cercanos) llevan oclusión y HRTF; el resto, distancia y balance. */
  maxActive: number;
}

export const SPATIAL_DEFAULT: SpatialConfig = {
  quality: 'high',
  near: 3,
  far: 24,
  rolloff: 1.6,
  wallGain: 0.55,
  wallCutoff: 1600,
  maxWalls: 4,
  reverb: { wet: 0.3, decay: 1.1, lp: 7500 },
  occlusionHz: 8,
  maxActive: 8,
};

/** Ajustes por perfil que pisan a los de la configuración. */
export const SPATIAL_PROFILES: Record<SpatialQuality, Partial<SpatialConfig>> = {
  off: {},
  low: { occlusionHz: 4, maxActive: 4 },
  medium: { occlusionHz: 6, maxActive: 6 },
  high: {},
};

interface Emitter {
  src: AudioNode;
  gain: GainNode;
  lp: BiquadFilterNode;
  pan: PannerNode | StereoPannerNode;
  send: GainNode;
  pos?: Vec3;
  /** Suena como si estuviera al lado (una llamada): sin distancia ni paredes. */
  near?: boolean;
  /** Sin dato de posición: se oye entero y centrado. */
  free?: boolean;
  walls: number;
  thick: number;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class Spatial {
  cfg: SpatialConfig;
  world?: VoiceWorld;
  private em = new Map<string, Emitter>();
  private listener: { pos: Vec3; fwd: Vec3; up: Vec3 } = { pos: [0, 0, 0], fwd: [0, 0, -1], up: [0, 1, 0] };
  private bus: { conv: ConvolverNode; lp: BiquadFilterNode; wet: GainNode };
  private revKey = '';
  private lastRays = 0;
  private roomVol = 0;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    cfg: Partial<SpatialConfig> = {},
  ) {
    this.cfg = this.merge(cfg);
    const conv = ctx.createConvolver(),
      lp = ctx.createBiquadFilter(),
      wet = ctx.createGain();
    lp.type = 'lowpass';
    conv.connect(lp).connect(wet).connect(out);
    this.bus = { conv, lp, wet };
    this.tuneReverb(true);
  }

  private merge(c: Partial<SpatialConfig>): SpatialConfig {
    const q = c.quality ?? this.cfg?.quality ?? SPATIAL_DEFAULT.quality;
    return { ...SPATIAL_DEFAULT, ...(this.cfg ?? {}), ...c, ...SPATIAL_PROFILES[q], quality: q };
  }

  /** Cambia cualquier parámetro en vivo. */
  configure(c: Partial<SpatialConfig>) {
    const q = this.cfg.quality;
    this.cfg = this.merge(c);
    if (this.cfg.quality !== q) for (const [id, e] of [...this.em]) this.rebuild(id, e);
    this.tuneReverb(true);
  }

  /** Engancha la fuente de una voz (un MediaStreamSource, por ejemplo); `id` identifica al emisor. */
  addEmitter(id: string, src: AudioNode) {
    this.removeEmitter(id);
    const e = this.build(src);
    this.em.set(id, e);
  }
  removeEmitter(id: string) {
    const e = this.em.get(id);
    if (!e) return;
    this.em.delete(id);
    this.teardown(e);
  }

  private build(src: AudioNode, keep?: Pick<Emitter, 'pos' | 'near' | 'free'>): Emitter {
    const c = this.ctx,
      gain = c.createGain(),
      lp = c.createBiquadFilter(),
      send = c.createGain();
    lp.type = 'lowpass';
    lp.frequency.value = 20000;
    const hrtf = this.cfg.quality === 'medium' || this.cfg.quality === 'high';
    let pan: PannerNode | StereoPannerNode;
    if (hrtf) {
      const p = c.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 1;
      p.rolloffFactor = 0; // (la caída la pone esta clase, con su propia curva)
      pan = p;
    } else pan = c.createStereoPanner();
    src.connect(gain).connect(lp).connect(pan).connect(this.out);
    if (this.cfg.quality !== 'off' && this.cfg.quality !== 'low') lp.connect(send).connect(this.bus.conv);
    send.gain.value = 1;
    return { src, gain, lp, pan, send, walls: 0, thick: 0, ...keep };
  }
  private teardown(e: Emitter) {
    e.src.disconnect(e.gain);
    [e.gain, e.lp, e.pan, e.send].forEach((n) => n.disconnect());
  }
  private rebuild(id: string, e: Emitter) {
    this.teardown(e);
    this.em.set(id, this.build(e.src, { pos: e.pos, near: e.near, free: e.free }));
  }

  setListener(pos: Vec3, forward: Vec3, up: Vec3 = [0, 1, 0]) {
    this.listener = { pos, fwd: forward, up };
    const l = this.ctx.listener, t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos[0], t, 0.03);
      l.positionY.setTargetAtTime(pos[1], t, 0.03);
      l.positionZ.setTargetAtTime(pos[2], t, 0.03);
      l.forwardX.setTargetAtTime(forward[0], t, 0.03);
      l.forwardY.setTargetAtTime(forward[1], t, 0.03);
      l.forwardZ.setTargetAtTime(forward[2], t, 0.03);
      l.upX.value = up[0];
      l.upY.value = up[1];
      l.upZ.value = up[2];
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(...pos);
      (l as unknown as { setOrientation(...a: number[]): void }).setOrientation(...forward, ...up);
    }
  }

  /** Dónde está un emisor. `near` = como si estuviera al lado (una llamada); `free` = sin sitio en el mapa (se oye entero y centrado). */
  setEmitter(id: string, pos: Vec3 | undefined, o: { near?: boolean; free?: boolean } = {}) {
    const e = this.em.get(id);
    if (!e) return;
    e.pos = pos;
    e.near = o.near;
    e.free = o.free || !pos;
  }

  /** Recalcula volumen, filtro, balance y reverb de cada emisor. Llamar cada fotograma (o a ~15 Hz). */
  update(now = performance.now()) {
    const c = this.cfg, t = this.ctx.currentTime;
    if (c.quality === 'off') {
      for (const e of this.em.values()) this.apply(e, 1, 20000, undefined, t);
      return;
    }
    // los más cercanos llevan oclusión; el resto, solo distancia
    const list = [...this.em.values()].map((e) => ({ e, d: e.pos && !e.free && !e.near ? dist(e.pos, this.listener.pos) : 0 }));
    list.sort((a, b) => a.d - b.d);
    const rays = c.quality === 'high' && this.world && now - this.lastRays >= 1000 / c.occlusionHz;
    if (rays) {
      this.lastRays = now;
      list.slice(0, c.maxActive).forEach(({ e }) => {
        if (!e.pos || e.free || e.near) return (e.walls = 0), void (e.thick = 0);
        const r = this.world!.raycast(this.listener.pos, e.pos);
        e.walls = Math.min(c.maxWalls, r.walls);
        e.thick = r.thickness ?? r.walls * 0.2;
      });
      if (this.world!.roomSize) this.roomVol += (this.world!.roomSize(this.listener.pos) - this.roomVol) * 0.5;
      this.tuneReverb();
    }
    list.forEach(({ e, d }, i) => {
      if (e.free || !e.pos) return this.apply(e, 1, 20000, undefined, t);
      const k = e.near ? 1 : Math.max(0, Math.min(1, 1 - (d - c.near) / (c.far - c.near))) ** c.rolloff;
      const walls = i < c.maxActive ? e.walls : 0;
      // cada pared baja el volumen y apaga más la voz (más cuanto más gruesa)
      const g = k * c.wallGain ** walls * Math.exp(-Math.max(0, e.thick - walls * 0.2) * 1.5);
      const cut = Math.max(350, Math.min(18000, (900 + 15100 * k ** 0.7) * (walls ? c.wallCutoff / 16000 + (1 / (1 + walls)) * 0.2 : 1)));
      this.apply(e, g, cut, i < c.maxActive || c.quality === 'low' ? e.pos : undefined, t, k);
    });
  }

  private apply(e: Emitter, gain: number, cutoff: number, pos: Vec3 | undefined, t: number, k = 1) {
    e.gain.gain.setTargetAtTime(gain, t, 0.08);
    e.lp.frequency.setTargetAtTime(cutoff, t, 0.08);
    e.send.gain.setTargetAtTime(Math.min(1, 0.4 + (1 - k) * 0.8), t, 0.1); // (más lejos, más reverb en proporción)
    if ('positionX' in e.pan) {
      const p = pos ?? this.listener.pos, ref = this.listener.pos, dx = p[0] - ref[0], dy = p[1] - ref[1], dz = p[2] - ref[2], n = Math.hypot(dx, dy, dz) || 1;
      // el panner mira solo la dirección (la caída ya está en `gain`): se pone a 1 m en esa dirección, para que HRTF no cambie el volumen
      const s = pos ? 1 / n : 0;
      e.pan.positionX.setTargetAtTime(ref[0] + dx * s, t, 0.05);
      e.pan.positionY.setTargetAtTime(ref[1] + dy * s, t, 0.05);
      e.pan.positionZ.setTargetAtTime(ref[2] + dz * s, t, 0.05);
    } else {
      const f = this.listener.fwd, u = this.listener.up;
      const rx = f[1] * u[2] - f[2] * u[1], rz = f[0] * u[1] - f[1] * u[0]; // derecha = adelante × arriba
      const p = pos ?? this.listener.pos, ref = this.listener.pos, dx = p[0] - ref[0], dz = p[2] - ref[2], n = Math.hypot(dx, dz);
      (e.pan as StereoPannerNode).pan.setTargetAtTime(pos && n > 0.01 ? Math.max(-0.85, Math.min(0.85, (dx * rx + dz * rz) / n)) * Math.min(1, n / 2) : 0, t, 0.08);
    }
  }

  /** Reverb: la cola y el volumen salen del tamaño de la sala medida (perfil alto) o del preajuste. */
  tuneReverb(force = false) {
    const c = this.cfg;
    let wet = c.reverb.wet, decay = c.reverb.decay;
    if (c.quality === 'high' && this.roomVol > 0) {
      const cb = Math.cbrt(this.roomVol);
      decay = Math.max(0.3, Math.min(3.2, 0.15 + 0.12 * cb));
      wet = Math.max(0.08, Math.min(0.55, 0.1 + 0.02 * cb));
    }
    if (c.quality === 'off' || c.quality === 'low') wet = 0;
    const key = `${decay.toFixed(1)}|${c.reverb.lp}`;
    this.bus.wet.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.2);
    this.bus.lp.frequency.value = c.reverb.lp;
    if (key === this.revKey && !force) return;
    if (key === this.revKey) return;
    this.revKey = key;
    const r = this.ctx.sampleRate, n = Math.floor(r * decay), buf = this.ctx.createBuffer(2, n, r);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2.5;
    }
    this.bus.conv.buffer = buf;
  }

  dispose() {
    [...this.em.keys()].forEach((id) => this.removeEmitter(id));
    this.bus.conv.disconnect();
    this.bus.lp.disconnect();
    this.bus.wet.disconnect();
  }
}
