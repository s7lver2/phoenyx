// Subida de texturas de three (Texture, CanvasTexture, DataTexture) a phoenyx-gl, con su muestreador y su clave por material.
// @ts-nocheck (usa el JS de three copiado)
import { SRGBColorSpace, RepeatWrapping, ClampToEdgeWrapping, MirroredRepeatWrapping, NearestFilter, LinearFilter, NearestMipmapNearestFilter, NearestMipmapLinearFilter, LinearMipmapNearestFilter, LinearMipmapLinearFilter } from './three/constants.js';

/** Lado maximo de textura del dispositivo por defecto en WebGPU (max_texture_dimension_2d). */
const MAX_TEX = 8192;
const warned = new Set<string>();
const warnOnce = (k: string, msg: string) => {
  if (!warned.has(k)) (warned.add(k), console.warn('[phoenyx] ' + msg));
};

export class TextureCache {
  private ids = new WeakMap<object, { id: number; version: number; source: any }>();
  private samplers = new Map<string, number>();
  private keys = new Map<string, number>();
  private nextTex = 1;
  private nextSampler = 1;
  private nextKey = 1;
  private scratch: HTMLCanvasElement | null = null;
  /** texturas subidas (para `renderer.info.memory.textures`) */
  count = 0;

  constructor(private gl: any) {}

  /** Pixeles RGBA de 8 bits con las filas en el orden de `flipY`; null si la imagen aun no esta lista. */
  private pixels(tex: any): { w: number; h: number; data: Uint8Array } | null {
    const img = tex.image;
    if (!img) return null;
    if (img.data) {
      // DataTexture
      const { width: w, height: h, data } = img;
      if (!w || !h) return null;
      let rgba: Uint8Array;
      if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
        if (data.length >= w * h * 4) rgba = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length);
        else {
          warnOnce('dt-fmt', 'DataTexture con menos de 4 canales: se rellena como RGBA');
          rgba = new Uint8Array(w * h * 4);
          const n = Math.max(1, Math.floor(data.length / (w * h)));
          for (let i = 0; i < w * h; i++) for (let c = 0; c < 4; c++) rgba[i * 4 + c] = c < n ? data[i * n + c] : c === 3 ? 255 : data[i * n];
        }
      } else {
        warnOnce('dt-type', 'DataTexture que no es de 8 bits: se convierte a 8 bits');
        rgba = new Uint8Array(w * h * 4);
        for (let i = 0; i < Math.min(rgba.length, data.length); i++) rgba[i] = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
      }
      return { w, h, data: tex.flipY ? flipRows(rgba, w, h) : rgba };
    }
    const w = img.naturalWidth || img.videoWidth || img.width, h = img.naturalHeight || img.videoHeight || img.height;
    if (!w || !h || (img.complete === false)) return null;
    // como three (resizeImage): una imagen mayor que el limite de la GPU se reduce
    const k = Math.min(1, MAX_TEX / Math.max(w, h));
    const cw = Math.max(1, Math.floor(w * k)), ch = Math.max(1, Math.floor(h * k));
    const cv = (this.scratch ??= document.createElement('canvas'));
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    let px: Uint8ClampedArray;
    try {
      px = ctx.getImageData(0, 0, cw, ch).data;
    } catch (e) {
      warnOnce('tainted', 'imagen de otro origen sin CORS: no se puede leer y no se dibuja');
      return null;
    }
    const rgba = new Uint8Array(px.buffer, px.byteOffset, px.length);
    return { w: cw, h: ch, data: tex.flipY ? flipRows(rgba, cw, ch) : rgba };
  }

  /** Id de la textura en la GPU (0 si no esta lista); la sube de nuevo si cambio su `version`. */
  private textureId(tex: any): number {
    if (!tex) return 0;
    let rec = this.ids.get(tex);
    if (rec && rec.version === tex.version && rec.source === tex.image) return rec.id;
    const px = this.pixels(tex);
    if (!px) return rec ? rec.id : 0;
    if (!rec) {
      const r = { id: this.nextTex++, version: -1, source: null };
      rec = r;
      this.ids.set(tex, r);
      this.count++;
      tex.addEventListener('dispose', () => {
        if (this.ids.get(tex) !== r) return;
        this.gl.drop_texture(r.id);
        this.ids.delete(tex);
        this.count--;
      });
    }
    this.gl.set_texture(rec.id, px.w, px.h, px.data, tex.colorSpace === SRGBColorSpace, tex.generateMipmaps !== false);
    rec.version = tex.version;
    rec.source = tex.image;
    return rec.id;
  }

  private samplerId(tex: any): number {
    if (!tex) return 0;
    const wrap = (w: number) => (w === RepeatWrapping ? 0 : w === ClampToEdgeWrapping ? 1 : w === MirroredRepeatWrapping ? 2 : 0);
    const mips = tex.generateMipmaps !== false;
    const min = tex.minFilter;
    const minLinear = min === LinearFilter || min === LinearMipmapNearestFilter || min === LinearMipmapLinearFilter;
    // sin mipmaps, los filtros con mipmap se comportan como Nearest o Linear sin ellas
    const mip = !mips ? 0 : min === NearestMipmapLinearFilter || min === LinearMipmapLinearFilter ? 2 : min === NearestMipmapNearestFilter || min === LinearMipmapNearestFilter ? 1 : 0;
    const args = [wrap(tex.wrapS), wrap(tex.wrapT), tex.magFilter !== NearestFilter, minLinear, mip, Math.min(16, Math.max(1, tex.anisotropy || 1))];
    const k = args.join(',');
    let id = this.samplers.get(k);
    if (id === undefined) {
      id = this.nextSampler++;
      this.samplers.set(k, id);
      this.gl.set_sampler(id, ...args);
    }
    return id;
  }

  /** Clave del conjunto de texturas de un material (0 si no tiene): se registra en la GPU la primera vez. */
  materialKey(m: any): number {
    const std = m.isMeshStandardMaterial;
    const list = [m.map, std ? m.normalMap : null, std ? m.roughnessMap : null, std ? m.emissiveMap : null, std ? m.bumpMap : null];
    if (!list.some(Boolean)) return 0;
    const tex = list.map((t) => this.textureId(t));
    const samp = list.map((t) => this.samplerId(t));
    const k = tex.join(',') + '|' + samp.join(',');
    let key = this.keys.get(k);
    if (key === undefined) {
      key = this.nextKey++;
      this.keys.set(k, key);
      this.gl.set_material_textures(key, new Uint32Array(tex), new Uint32Array(samp));
    }
    return key;
  }
}

function flipRows(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}
