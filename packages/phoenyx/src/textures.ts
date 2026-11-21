// Subida de texturas de three (Texture, CanvasTexture, DataTexture) a phoenyx-gl, con su muestreador y su clave por material.
// @ts-nocheck (usa el JS de three copiado)
import { HalfFloatType, FloatType, SRGBColorSpace, RepeatWrapping, ClampToEdgeWrapping, MirroredRepeatWrapping, NearestFilter, LinearFilter, NearestMipmapNearestFilter, NearestMipmapLinearFilter, LinearMipmapNearestFilter, LinearMipmapLinearFilter } from './three/constants.js';

/** Lado maximo de textura del dispositivo por defecto en WebGPU (max_texture_dimension_2d). */
const MAX_TEX = 8192;
const warned = new Set<string>();
const warnOnce = (k: string, msg: string) => {
  if (!warned.has(k)) (warned.add(k), console.warn('[phoenyx] ' + msg));
};

/** Una textura tiene cadena de mipmaps si three debe generarla o si ya trae varios niveles (KTX2). */
const hasMips = (tex: any) => tex.generateMipmaps !== false || (tex.isCompressedTexture && tex.mipmaps?.length > 1);

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
  /** id de textura del render target que se esta dibujando: no se puede leer a la vez (feedback), se trata como no lista */
  avoid = 0;
  private rts = new WeakMap<object, { id: number; depthId: number; w: number; h: number; fmt: number }>();
  private rtOf = new WeakMap<object, object>();

  constructor(private gl: any) {}
  /** El renderer se libero: los dispose de texturas y render targets posteriores ya no tocan la GPU. */
  release() {
    this.gl = null;
  }

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

  /** Niveles de una CompressedTexture (la de KTX2Loader) como (anchos y altos, datos seguidos); null si no tiene datos. */
  private compressedLevels(tex: any): { dims: Uint32Array; data: Uint8Array } | null {
    const mm = tex.mipmaps;
    if (!mm || !mm.length || !mm[0].data) return null;
    const dims = new Uint32Array(mm.length * 2);
    let total = 0;
    for (let i = 0; i < mm.length; i++) {
      dims[i * 2] = mm[i].width;
      dims[i * 2 + 1] = mm[i].height;
      total += mm[i].data.byteLength;
    }
    const data = new Uint8Array(total);
    let off = 0;
    for (const m of mm) {
      data.set(new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.byteLength), off);
      off += m.data.byteLength;
    }
    return { dims, data };
  }

  /** Registra (o redimensiona) el render target en la GPU y devuelve el id de su textura de color. */
  target(rt: any): number {
    const fmt = rt.texture.type === HalfFloatType || rt.texture.type === FloatType ? 1 : 2;
    const w = Math.max(1, Math.floor(rt.width)), h = Math.max(1, Math.floor(rt.height));
    let rec = this.rts.get(rt);
    const depthTex = rt.depthTexture ?? null;
    if (rec && rec.w === w && rec.h === h && rec.fmt === fmt && !!rec.depthId === !!depthTex) return rec.id;
    if (!rec) {
      const r = { id: this.nextTex++, depthId: 0, w: 0, h: 0, fmt };
      rec = r;
      this.rts.set(rt, r);
      this.count++;
      this.ids.set(rt.texture, { id: r.id, version: -1, source: null, rt: true } as any);
      this.rtOf.set(rt.texture, rt);
      rt.addEventListener('dispose', () => {
        if (this.rts.get(rt) !== r) return;
        this.gl?.drop_target(r.id);
        this.rts.delete(rt);
        this.count--;
      });
    }
    rec.depthId = depthTex ? rec.depthId || this.nextTex++ : 0;
    if (depthTex) this.ids.set(depthTex, { id: rec.depthId, version: -1, source: null, rt: true } as any);
    rec.w = w, rec.h = h, rec.fmt = fmt;
    this.gl.create_target(rec.id, w, h, fmt, rec.depthId);
    return rec.id;
  }

  /** Id de la textura en la GPU (0 si no esta lista); la sube de nuevo si cambio su `version`. */
  private textureId(tex: any): number {
    if (!tex) return 0;
    let rec = this.ids.get(tex);
    if (rec && (rec as any).rt) return rec.id === this.avoid ? 0 : rec.id;
    // textura de render target o de profundidad que aun no se ha creado en la GPU
    if (!rec && (tex.isDepthTexture || tex.isRenderTargetTexture)) return 0;
    if (rec && rec.version === tex.version && rec.source === tex.image) return rec.id;
    // KTX2/Basis: los mipmaps llegan ya transcodificados (comprimidos para la GPU o RGBA8 de reserva)
    const comp = tex.isCompressedTexture ? this.compressedLevels(tex) : null;
    const px = comp ? null : tex.isCompressedTexture ? null : this.pixels(tex);
    if (!comp && !px) return rec ? rec.id : 0;
    if (!rec) {
      const r = { id: this.nextTex++, version: -1, source: null };
      rec = r;
      this.ids.set(tex, r);
      this.count++;
      tex.addEventListener('dispose', () => {
        if (this.ids.get(tex) !== r) return;
        this.gl?.drop_texture(r.id);
        this.ids.delete(tex);
        this.count--;
      });
    }
    if (comp) {
      if (!this.gl.set_texture_compressed(rec.id, tex.format, comp.dims, comp.data, tex.colorSpace === SRGBColorSpace)) {
        warnOnce('ktx-fmt' + tex.format, `formato de textura comprimida ${tex.format} no admitido por esta GPU: la textura no se dibuja`);
      }
    } else this.gl.set_texture(rec.id, px.w, px.h, px.data, tex.colorSpace === SRGBColorSpace, tex.generateMipmaps !== false);
    rec.version = tex.version;
    rec.source = tex.image;
    return rec.id;
  }

  /** Id de GPU de cualquier textura (subiendola si hace falta). */
  idOf(tex: any): number {
    return this.textureId(tex);
  }

  /** Ultimo muestreador calculado por textura y los campos de los que depende (evita construir la clave de texto en cada dibujo). */
  private samplerMemo = new WeakMap<object, { f: number[]; id: number }>();
  private mkMemo = new WeakMap<object, { s: number[]; key: number }>();
  private mkScratch: number[] = new Array(10).fill(0);

  private samplerId(tex: any): number {
    if (!tex) return 0;
    const memo = this.samplerMemo.get(tex);
    if (memo) {
      const f = memo.f;
      if (f[0] === tex.wrapS && f[1] === tex.wrapT && f[2] === tex.magFilter && f[3] === tex.minFilter && f[4] === (hasMips(tex) ? 1 : 0) && f[5] === (tex.anisotropy || 1)) return memo.id;
    }
    const id = this.samplerIdSlow(tex);
    this.samplerMemo.set(tex, { f: [tex.wrapS, tex.wrapT, tex.magFilter, tex.minFilter, hasMips(tex) ? 1 : 0, tex.anisotropy || 1], id });
    return id;
  }

  private samplerIdSlow(tex: any): number {
    const wrap = (w: number) => (w === RepeatWrapping ? 0 : w === ClampToEdgeWrapping ? 1 : w === MirroredRepeatWrapping ? 2 : 0);
    const mips = hasMips(tex);
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
    // ids de textura y de muestreador de las 5 ranuras (sin crear arrays: la clave solo se rehace si alguno cambia)
    const s = this.mkScratch;
    let any = false;
    for (let i = 0; i < 5; i++) {
      const t = i === 0 ? m.map : !std ? null : i === 1 ? m.normalMap : i === 2 ? m.roughnessMap : i === 3 ? m.emissiveMap : m.bumpMap;
      if (t) any = true;
      s[i] = this.textureId(t);
      s[5 + i] = this.samplerId(t);
    }
    if (!any) return 0;
    const memo = this.mkMemo.get(m);
    if (memo) {
      let same = true;
      for (let i = 0; i < 10; i++) if (memo.s[i] !== s[i]) { same = false; break; }
      if (same) return memo.key;
    }
    const key = this.listKey([m.map, std ? m.normalMap : null, std ? m.roughnessMap : null, std ? m.emissiveMap : null, std ? m.bumpMap : null]);
    this.mkMemo.set(m, { s: s.slice(), key });
    return key;
  }

  /** Clave de un conjunto de hasta 5 texturas (huecos null); 0 si no hay ninguna. */
  listKey(list: any[]): number {
    list = [...list, null, null, null, null, null].slice(0, 5);
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
