// WebGLRenderer de Phoenyx: misma API que el de three (la parte que usa el juego), dibujando con phoenyx-gl (WebGPU).
// @ts-nocheck (usa el JS de three copiado)
import { UniformsLib } from './three/renderers/shaders/UniformsLib.js';
import init, { create } from '../pkg/phoenyx_gl.js';
import { Packer } from './pack';
import { TextureCache } from './textures';
import { passShaderOf, blendOf } from './passes';
import { userShaderOf } from './user-shaders/index';
import './user-shaders/prueba';
import './user-shaders/waterjet';
import './user-shaders/parking-atmosphere';
import './user-shaders/remote';
import './user-shaders/vents';
import './user-shaders/dust-cam';
import './user-shaders/dust-world';
import { Color } from './three/math/Color.js';
import { BufferGeometry } from './three/core/BufferGeometry.js';
import { ACESFilmicToneMapping, NoToneMapping, SRGBColorSpace, LinearSRGBColorSpace } from './three/constants.js';

const warned = new Set<string>();
const warnOnce = (k: string, msg: string) => {
  if (!warned.has(k)) (warned.add(k), console.warn('[phoenyx] ' + msg));
};

/** Si el anfitrion no sirve el wasm junto al modulo, define `globalThis.PHOENYX_WASM_URL` antes de crear el renderer. */
const wasmUrl = () => (globalThis as any).PHOENYX_WASM_URL;

export class WebGLRenderer {
  domElement: HTMLCanvasElement;
  outputColorSpace = SRGBColorSpace;
  toneMapping = NoToneMapping;
  toneMappingExposure = 1;
  autoClear = true;
  autoClearColor = true;
  autoClearDepth = true;
  autoClearStencil = true;
  /** Se resuelve cuando la GPU esta lista; `render()` antes no hace nada. */
  ready: Promise<void>;
  info = {
    autoReset: true,
    render: { calls: 0, triangles: 0, frame: 0 },
    memory: { geometries: 0, textures: 0 },
    reset() {
      this.render.calls = 0;
      this.render.triangles = 0;
    },
  };

  private gl: any = null;
  private textures!: TextureCache;
  private packer = new Packer();
  private pixelRatio = 1;
  private width = 0;
  private height = 0;
  private clearColor = new Color(0x000000);
  private clearAlpha = 1;
  private ids = new WeakMap<object, { id: number; key: string }>();
  private nextId = 1;
  private nextInst = 1;
  private attrIds = new WeakMap<object, number>();
  private nextAttr = 1;
  private lostReported = false;
  private ltcDone = false;
  /** como three: enabled, type (BasicShadowMap 0, PCFShadowMap 1, PCFSoftShadowMap 2), autoUpdate y needsUpdate */
  shadowMap = { enabled: false, autoUpdate: true, needsUpdate: false, type: 1 };
  private disposed = false;
  private rt: any = null;

  constructor(params: { canvas?: HTMLCanvasElement; antialias?: boolean; alpha?: boolean; powerPreference?: string } = {}) {
    this.domElement = params.canvas ?? document.createElement('canvas');
    this.ready = (async () => {
      const url = wasmUrl();
      await init(url ? { module_or_path: url } : undefined);
      const gl = await create(this.domElement);
      if (this.disposed) return;
      this.gl = gl;
      this.textures = new TextureCache(gl);
    })();
    this.ready.catch((e) => console.error('[phoenyx] no se pudo iniciar la GPU:', e));
  }

  setPixelRatio(r: number) {
    this.pixelRatio = r;
    if (this.width) this.setSize(this.width, this.height, false);
  }
  getPixelRatio() {
    return this.pixelRatio;
  }
  setSize(w: number, h: number, updateStyle = true) {
    this.width = w;
    this.height = h;
    this.domElement.width = Math.floor(w * this.pixelRatio);
    this.domElement.height = Math.floor(h * this.pixelRatio);
    if (updateStyle) {
      this.domElement.style.width = w + 'px';
      this.domElement.style.height = h + 'px';
    }
  }
  getSize(target: { set(x: number, y: number): unknown }) {
    return target.set(this.width, this.height);
  }
  setClearColor(color: any, alpha = 1) {
    this.clearColor.set(color);
    this.clearAlpha = alpha;
  }
  getClearColor(target: any) {
    return target.copy(this.clearColor);
  }
  setClearAlpha(a: number) {
    this.clearAlpha = a;
  }
  getClearAlpha() {
    return this.clearAlpha;
  }

  /** Destino de los dibujos siguientes: un WebGLRenderTarget o null (la pantalla). */
  setRenderTarget(rt: any, _activeCubeFace?: number, _activeMipmapLevel?: number) {
    this.rt = rt ?? null;
    this.syncTarget();
  }
  getRenderTarget() {
    return this.rt;
  }
  /** Lleva a la GPU el destino actual (crea o redimensiona el RT) y evita leer su textura mientras se dibuja en ella. */
  private syncTarget() {
    if (!this.gl) return;
    if (this.rt) {
      const id = this.textures.target(this.rt);
      this.textures.avoid = id;
      this.gl.set_target(id);
    } else {
      this.textures.avoid = 0;
      this.gl.set_target(0xffffffff);
    }
  }
  /** WebGLRenderer.clear: el siguiente dibujo en el destino actual limpia color y/o profundidad. */
  clear(color = true, depth = true, _stencil = true) {
    if (!this.gl) return;
    this.syncTarget();
    const rgb = { r: 0, g: 0, b: 0 };
    this.clearColor.getRGB(rgb, this.rt ? LinearSRGBColorSpace : this.outputColorSpace);
    this.gl.clear(rgb.r, rgb.g, rgb.b, this.clearAlpha, !!color, !!depth);
  }
  clearColorBuffer() {
    this.clear(true, false, false);
  }
  clearDepth() {
    this.clear(false, true, false);
  }

  private insts = new WeakMap<object, { id: number; key: string }>();

  /** Sube las matrices y colores de un InstancedMesh cuando cambian (version o count) y devuelve su id. */
  private instInfo(o: any) {
    const im = o.instanceMatrix, ic = o.instanceColor;
    if (!im) return null;
    const count = Math.min(o.count, im.count);
    const aid = (a: any) => {
      let i = this.attrIds.get(a);
      if (!i) this.attrIds.set(a, (i = this.nextAttr++));
      return `${i}.${a.version}`;
    };
    const key = `${aid(im)}|${ic ? aid(ic) : 0}|${count}`;
    let rec = this.insts.get(o);
    if (!rec || rec.key !== key) {
      if (!rec) {
        const r = { id: this.nextInst++, key };
        rec = r;
        this.insts.set(o, r);
        o.addEventListener('dispose', () => {
          this.gl?.drop_instances(r.id);
          this.insts.delete(o);
        });
      }
      rec.key = key;
      this.gl.set_instances(rec.id, im.array.subarray(0, count * 16), ic && ic.count >= count ? ic.array.subarray(0, count * 3) : new Float32Array(0));
    }
    return { id: rec.id, count, color: !!ic && ic.count >= count };
  }

  private bones = new Map<object, { id: number; seen: number }>();
  private renderCount = 0;
  private boneBuf = new Float32Array(0);
  private noColors = new Float32Array(0);

  /** Sube el tramo de huesos de una SkinnedMesh ([bindMatrix, bindMatrixInverse, boneMatrices]) una vez por render y devuelve su clave. */
  private boneInfo(o: any): number {
    const sk = o.skeleton;
    if (!sk) return 0;
    let rec = this.bones.get(o);
    if (!rec) this.bones.set(o, (rec = { id: this.nextInst++, seen: -1 }));
    if (rec.seen !== this.renderCount) {
      rec.seen = this.renderCount;
      // como WebGLRenderer: skeleton.update() antes de dibujar
      sk.update();
      const bm = sk.boneMatrices;
      if (this.boneBuf.length < bm.length + 32) this.boneBuf = new Float32Array((bm.length + 32) * 2);
      this.boneBuf.set(o.bindMatrix.elements, 0);
      this.boneBuf.set(o.bindMatrixInverse.elements, 16);
      this.boneBuf.set(bm, 32);
      this.gl.set_instances(rec.id, this.boneBuf.subarray(0, bm.length + 32), this.noColors);
    }
    return rec.id;
  }

  /** Libera los tramos de huesos de mallas que llevan mucho sin dibujarse (quitadas, ocultas o destruidas). */
  private sweepBones() {
    for (const [o, r] of this.bones) {
      if (this.renderCount - r.seen > 512) {
        this.gl?.drop_instances(r.id);
        this.bones.delete(o);
      }
    }
  }

  /** Shader de usuario de un ShaderMaterial de la escena: id del WGSL, uniformes del fotograma, clave de texturas y mezcla empaquetada (null si no esta portado). */
  private userInfo(m: any) {
    const def = userShaderOf(m);
    if (!def) return null;
    const b = blendOf(m);
    return {
      id: def.id,
      points: !!def.points,
      attributes: def.attributes ?? null,
      values: [m.fog ? 1 : 0, 0, 0, 0, ...def.pack(m)],
      texKey: this.textures.listKey(def.textures ? def.textures(m) : []),
      b0: b[1] | (b[2] << 8) | (b[3] << 16) | (b[0] << 24),
      b1: b[4] | (b[5] << 8) | (b[6] << 16),
    };
  }

  /** Normales de una geometria que no las trae (sin tocar la geometria del juego). */
  private normalsOf(g: any): Float32Array {
    const t = new BufferGeometry();
    t.setAttribute('position', g.attributes.position);
    if (g.index) t.setIndex(g.index);
    t.computeVertexNormals();
    return t.attributes.normal.array as Float32Array;
  }

  /** Sube la geometria a la GPU si es nueva o cambio (version de sus atributos) y devuelve su id. */
  private geomId(g: any, slots?: { normal?: string[]; uv?: string[]; color?: string[] } | null): number {
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
    const aid = (a: any) => {
      if (!a) return 0;
      let i = this.attrIds.get(a);
      if (!i) this.attrIds.set(a, (i = this.nextAttr++));
      return `${i}.${(a.data ?? a).version}.${a.count}`;
    };
    const slotKey = slots ? ['normal', 'uv', 'color'].map((k) => (slots[k] ?? []).map((n) => aid(g.attributes[n])).join('+')).join('/') : '';
    const key = `${aid(pos)}:${aid(nor)}:${aid(uv)}:${aid(col)}:${aid(g.index)}:${aid(g.attributes.skinIndex)}:${aid(g.attributes.skinWeight)}:${slotKey}`;
    let rec = this.ids.get(g);
    if (rec && rec.key === key) return rec.id;
    const f32 = (a: any, n: number) => {
      if (!a) return new Float32Array(0);
      if (a.array instanceof Float32Array && !a.isInterleavedBufferAttribute && a.itemSize === n) return a.array;
      const out = new Float32Array(a.count * n);
      for (let i = 0; i < a.count; i++) {
        out[i * n] = a.getX(i);
        out[i * n + 1] = a.getY(i);
        if (n > 2) out[i * n + 2] = a.getZ(i);
      }
      return out;
    };
    let index: Uint32Array;
    if (g.index) index = g.index.array instanceof Uint32Array ? g.index.array : Uint32Array.from(g.index.array);
    else index = Uint32Array.from({ length: pos.count }, (_, i) => i);
    if (!rec) {
      const r = { id: this.nextId++, key };
      rec = r;
      this.ids.set(g, r);
      this.info.memory.geometries++;
      g.addEventListener('dispose', () => {
        if (this.ids.get(g) !== r) return;
        this.gl?.drop_geometry(r.id);
        this.ids.delete(g);
        this.info.memory.geometries--;
      });
    }
    rec.key = key;
    // piel: 4 indices de hueso (u32, el wasm los empaqueta a u16) y 4 pesos por vertice
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    let skinIdx = new Uint32Array(0), skinW = new Float32Array(0);
    if (si && sw && si.count === pos.count) {
      skinIdx = new Uint32Array(si.count * 4);
      skinW = new Float32Array(si.count * 4);
      for (let i = 0; i < si.count; i++) {
        skinIdx[i * 4] = si.getX(i); skinIdx[i * 4 + 1] = si.getY(i); skinIdx[i * 4 + 2] = si.getZ(i); skinIdx[i * 4 + 3] = si.getW(i);
        skinW[i * 4] = sw.getX(i); skinW[i * 4 + 1] = sw.getY(i); skinW[i * 4 + 2] = sw.getZ(i); skinW[i * 4 + 3] = sw.getW(i);
      }
    }
    // atributos propios de un shader de usuario: sus componentes se reparten en los huecos normal / uv / color del vertice
    const fromNames = (names: string[], k: number) => {
      const out = new Float32Array(pos.count * k);
      let c = 0;
      for (const n of names) {
        const a = g.attributes[n];
        if (!a) { c += 1; continue; }
        for (let j = 0; j < a.itemSize && c < k; j++, c++) for (let i = 0; i < pos.count; i++) out[i * k + c] = j === 0 ? a.getX(i) : j === 1 ? a.getY(i) : j === 2 ? a.getZ(i) : a.getW(i);
      }
      return out;
    };
    this.gl.set_geometry(rec.id, f32(pos, 3), slots?.normal ? fromNames(slots.normal, 3) : nor ? f32(nor, 3) : this.normalsOf(g), slots?.uv ? fromNames(slots.uv, 2) : f32(uv, 2), slots?.color ? fromNames(slots.color, 3) : f32(g.attributes.color, 3), index, skinIdx, skinW);
    return rec.id;
  }

  /** Ejecuta un ShaderMaterial de pantalla completa (lo que dibuja FullScreenQuad de los pases) con su WGSL portado. */
  private flushQueued = false;
  /** Un pase de pantalla completa: se graba en el Gl y se envia todo junto al acabar la tarea (o antes, si llega un fotograma o un cambio de target). */
  private emitPass(id: number, uniforms: Float32Array, blend: Uint32Array, tex: Uint32Array) {
    this.gl.pass(id, uniforms, blend, tex);
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => {
        this.flushQueued = false;
        if (!this.gl) return;
        this.gl.flush();
        const err = this.gl.take_error();
        if (err) console.error('[phoenyx] GPU:', err);
      });
    }
  }

  private renderPass(m: any) {
    this.syncTarget();
    // como render(): con autoClear el destino se limpia antes de dibujar (SMAAPass depende de ello: sus bordes sin borde se descartan)
    if (this.autoClear) this.clear(this.autoClearColor, this.autoClearDepth, this.autoClearStencil);
    const def = passShaderOf(m);
    if (!def) {
      warnOnce('pass:' + (m.name || m.uuid), 'ShaderMaterial de pase sin version WGSL: se copia la entrada');
      const src = m.uniforms.tDiffuse?.value;
      if (src) this.emitPass(0, new Float32Array([1]), new Uint32Array([0, 201, 200, 100, 201, 200, 100]), new Uint32Array([this.textures.idOf(src)]));
      return;
    }
    const tex = def.tex.map((n) => this.textures.idOf(m.uniforms[n]?.value));
    while (tex.length < 5) tex.push(0);
    tex.push(def.depth ? this.textures.idOf(m.uniforms[def.depth]?.value) : 0);
    this.emitPass(def.id, new Float32Array(def.pack(m)), new Uint32Array(blendOf(m)), new Uint32Array(tex));
    const err = this.gl.take_error();
    if (err) console.error('[phoenyx] GPU:', err);
  }

  render(scene: any, camera: any) {
    if (!this.gl) return;
    if (scene.isMesh && scene.material?.isShaderMaterial) return this.renderPass(scene.material);
    // pase que copia una textura con MeshBasicMaterial (UnrealBloomPass.renderToScreen)
    if (scene.isMesh && scene.material?.isMeshBasicMaterial && scene.material.map && !scene.geometry.index && scene.geometry.attributes.position.count === 3) {
      this.syncTarget();
      this.emitPass(0, new Float32Array([1]), new Uint32Array([0, 201, 200, 100, 201, 200, 100]), new Uint32Array([this.textures.idOf(scene.material.map)]));
      return;
    }
    if (this.gl.is_lost()) {
      if (!this.lostReported) (this.lostReported = true), console.error('[phoenyx] dispositivo GPU perdido:', this.gl.take_error());
      return;
    }
    this.gl.resize(this.domElement.width, this.domElement.height);
    this.syncTarget();
    const rtOut = !!this.rt;
    if (this.info.autoReset) this.info.reset();
    // fondo: scene.background (Color) o el color de limpieza, convertido al espacio de salida como hace three
    const rgb = { r: 0, g: 0, b: 0 };
    const forceClear = !!(scene.background && scene.background.isColor);
    const bg = forceClear ? scene.background : this.clearColor;
    const space = rtOut ? LinearSRGBColorSpace : this.outputColorSpace;
    bg.getRGB(rgb, space);
    const alpha = scene.background && scene.background.isColor ? 1 : this.clearAlpha;
    const tm = !rtOut && this.toneMapping === ACESFilmicToneMapping ? 1 : 0;
    if (!rtOut && this.toneMapping !== NoToneMapping && this.toneMapping !== ACESFilmicToneMapping) console.warn('[phoenyx] solo esta soportado ACESFilmicToneMapping');
    this.renderCount++;
    const p = this.packer.pack(scene, camera, { exposure: this.toneMappingExposure, toneMapping: tm, clear: [rgb.r, rgb.g, rgb.b, alpha], outputColorSpace: space, linear: rtOut, // con scene.background (Color) three limpia siempre, segun autoClearColor/autoClearDepth aunque autoClear sea false
 clearFlags: forceClear ? (this.autoClearColor ? 1 : 0) | (this.autoClearDepth ? 2 : 0) : this.autoClear ? (this.autoClearColor ? 1 : 0) | (this.autoClearDepth ? 2 : 0) : 0, size: rtOut ? [Math.max(1, Math.floor(this.rt.width)), Math.max(1, Math.floor(this.rt.height))] : [this.domElement.width, this.domElement.height], shadow: this.shadowMap }, (g, slots) => this.geomId(g, slots), (m) => this.textures.materialKey(m), (o) => this.instInfo(o), (o) => this.boneInfo(o), (m) => this.userInfo(m));
    // tablas LTC de RectAreaLight: las deja RectAreaLightUniformsLib.init() en UniformsLib
    if (!this.ltcDone && UniformsLib.LTC_FLOAT_1) {
      this.gl.set_ltc(UniformsLib.LTC_FLOAT_1.image.data, UniformsLib.LTC_FLOAT_2.image.data);
      this.ltcDone = true;
    }
    if (p.shadowAlloc) this.gl.set_shadow_maps(p.shadowAlloc[0], p.shadowAlloc[1]);
    // si el fotograma no llega a dibujarse (superficie perdida, cambio de tamano) los mapas quedan sin pintar: se repintan en el siguiente
    if (this.gl.frame(p.globals, p.objects, p.materials, p.lights, p.draws, p.shadows, p.shadowPasses, p.nDraws)) {
      if (p.shadowRan) this.shadowMap.needsUpdate = false;
    } else this.packer.forceShadows = true;
    const err = this.gl.take_error();
    if (err) console.error('[phoenyx] GPU:', err);
    this.info.render.calls += p.nDraws;
    this.info.render.triangles += p.triangles;
    this.info.render.frame++;
    this.info.memory.textures = this.textures.count;
    if (this.renderCount % 256 === 0) this.sweepBones();
  }

  dispose() {
    this.disposed = true;
    this.gl?.free?.();
    this.gl = null;
  }
}
