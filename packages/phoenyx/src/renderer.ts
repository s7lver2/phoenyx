// WebGLRenderer de Phoenyx: misma API que el de three (la parte que usa el juego), dibujando con phoenyx-gl (WebGPU).
// @ts-nocheck (usa el JS de three copiado)
import { UniformsLib } from './three/renderers/shaders/UniformsLib.js';
import init, { create } from '../pkg/phoenyx_gl.js';
import { Packer } from './pack';
import { TextureCache } from './textures';
import { passShaderOf, blendOf } from './passes';
import { userShaderOf } from './user-shaders/index';
import { patchOf } from './patches';
import './user-shaders/prueba';
import './user-shaders/waterjet';
import './user-shaders/parking-atmosphere';
import './user-shaders/remote';
import './user-shaders/vents';
import './user-shaders/dust-cam';
import './user-shaders/dust-world';
import './user-shaders/world-shaft';
import './user-shaders/world-sky';
import './user-shaders/pool-water';
import './user-shaders/poolmap-water';
import './user-shaders/world-carpet';
import './user-shaders/puddles';
import { Color } from './three/math/Color.js';
import { BufferGeometry } from './three/core/BufferGeometry.js';
import { Object3D } from './three/core/Object3D.js';
import { Frustum } from './three/math/Frustum.js';
import { Matrix4 } from './three/math/Matrix4.js';
import { ACESFilmicToneMapping, NoToneMapping, SRGBColorSpace, LinearSRGBColorSpace, CubeUVReflectionMapping } from './three/constants.js';

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
  /** profundidad de render() anidados (el Reflector dibuja la escena dentro de su onBeforeRender) */
  private depth = 0;
  private hookFrustum = new Frustum();
  private hookMatrix = new Matrix4();
  /** WebGLRenderer.capabilities: lo que consulta el juego (anisotropia) y lo basico que lee three */
  capabilities = { isWebGL2: true, maxTextureSize: 8192, maxAnisotropy: 16, precision: 'highp', getMaxAnisotropy: () => 16, getMaxPrecision: () => 'highp' };
  /** WebGLRenderer.extensions: no hay extensiones de WebGL; solo se anuncia la compilacion en paralelo (la GPU compila al primer dibujo) */
  extensions = { has: (name: string) => name === 'KHR_parallel_shader_compile', get: (_name: string) => null, init() {} };
  private loopId = 0;
  private loopFn: ((time: number, frame?: any) => void) | null = null;
  /** resguardos de la parte de WebGLRenderer que toca el Reflector: sin XR; el estado de GL lo lleva phoenyx-gl */
  xr = { enabled: false };
  state = { buffers: { depth: { setMask(_m: boolean) {} } }, viewport(_v: any) {} };

  constructor(params: { canvas?: HTMLCanvasElement; antialias?: boolean; alpha?: boolean; powerPreference?: string } = {}) {
    this.domElement = params.canvas ?? document.createElement('canvas');
    if (params.alpha) this.clearAlpha = 0; // como WebGLRenderer: con `alpha: true` el fondo empieza transparente
    this.ready = (async () => {
      const url = wasmUrl();
      await init(url ? { module_or_path: url } : undefined);
      const gl = await create(this.domElement, !!params.alpha);
      if (this.disposed) {
        gl.destroy();
        gl.free();
        return;
      }
      this.gl = gl;
      this.textures = new TextureCache(gl);
    })();
    this.ready.catch((e) => console.error('[phoenyx] no se pudo iniciar la GPU:', e));
  }

  /** Activa los temporizadores de GPU (timestamp-query); el resultado se lee con `gpuTimes()`. Sin soporte no hace nada. */
  setGpuTiming(on: boolean) {
    this.gl?.enable_timing(on);
  }
  /** Milisegundos de GPU de la ultima lectura: `shadow`, `scene` y `pass<id>` (pases de pantalla completa, sumados por id). */
  gpuTimes(): Record<string, number> {
    const a = this.gl?.timings() ?? [];
    const out: Record<string, number> = {};
    for (let i = 0; i + 1 < a.length; i += 2) out[a[i] === 1 ? 'shadow' : a[i] === 2 ? 'scene' : 'pass' + (a[i] - 100)] = +a[i + 1].toFixed(3);
    return out;
  }
  /** Tamano del bufer de dibujo en pixeles (como WebGLRenderer.getDrawingBufferSize). */
  getDrawingBufferSize(target: { set(x: number, y: number): unknown }) {
    return target.set(this.domElement.width, this.domElement.height);
  }
  /**
   * Sustituto del contexto de WebGL: lo que el juego le pregunta (perdida de contexto, el nombre de la GPU) y nada mas.
   * `WEBGL_debug_renderer_info` existe y `getParameter(UNMASKED_RENDERER_WEBGL)` devuelve el backend de phoenyx.
   */
  getContext() {
    const self = this;
    return {
      LINK_STATUS: 0x8b82,
      canvas: this.domElement,
      isContextLost: () => !!self.gl && self.gl.is_lost(),
      getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
      getParameter: (p: number) => (p === 0x9246 ? 'Phoenyx (WebGPU)' : p === 0x9245 ? 'phoenyx' : null),
      getProgramParameter: () => true,
      getSupportedExtensions: () => [],
    };
  }
  /** Sube la textura a la GPU ahora (la primera vez que se pinta cuesta un tiron). */
  initTexture(tex: any) {
    if (this.gl) this.textures.idOf(tex);
  }
  /** WebGLRenderer.setAnimationLoop: un bucle de requestAnimationFrame (sin XR); `null` lo detiene. */
  setAnimationLoop(cb: ((time: number, frame?: any) => void) | null) {
    this.loopFn = cb;
    if (this.loopId) cancelAnimationFrame(this.loopId), (this.loopId = 0);
    if (!cb) return;
    const tick = (t: number) => {
      this.loopId = requestAnimationFrame(tick);
      this.loopFn?.(t);
    };
    this.loopId = requestAnimationFrame(tick);
  }
  /** Libera la GPU del todo (el juego lo llama tras dispose()). */
  forceContextLoss() {
    this.dispose();
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
  getActiveCubeFace() {
    return 0;
  }
  getActiveMipmapLevel() {
    return 0;
  }
  /** WebGLRenderer.compile: la GPU compila los pipelines al primer dibujo. */
  compile(_scene?: any, _camera?: any) {}
  async compileAsync(_scene?: any, _camera?: any) {}
  /** Lleva a la GPU el destino actual (crea o redimensiona el RT) y evita leer su textura mientras se dibuja en ella. */
  private syncTarget() {
    if (!this.gl) return;
    if (this.rt) {
      const id = this.textures.target(this.rt);
      this.textures.avoid = id;
      this.gl.set_target(id);
      // viewport (siempre) y scissor (con scissorTest) del WebGLRenderTarget: PMREMGenerator pinta cada cara en su tesela
      const v = this.rt.viewport, s = this.rt.scissor;
      this.gl.set_viewport(v.x, v.y, v.z, v.w, this.rt.scissorTest ? s.x : 0, this.rt.scissorTest ? s.y : 0, this.rt.scissorTest ? s.z : 0, this.rt.scissorTest ? s.w : 0);
    } else {
      this.textures.avoid = 0;
      this.gl.set_target(0xffffffff);
      this.gl.set_viewport(0, 0, 0, 0, 0, 0, 0, 0);
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
  /** Parche de `onBeforeCompile` de un material estandar: id del gancho y sus uniformes de este fotograma (y sube el lightmap si cambio). */
  private patchInfo(m: any) {
    const p = patchOf(m, this);
    if (!p) return null;
    p.def.sync?.(p.uniforms, this.gl, this.patchState);
    return { id: p.def.id, extras: p.def.pack(p.uniforms) };
  }
  private patchState = { lmKey: '' };

  private userInfo(m: any) {
    const def = userShaderOf(m, { pixelRatio: this.pixelRatio, height: this.height, patch: (pm) => { const p = patchOf(pm, this); return p ? { id: p.def.id, value: p.def.pack(p.uniforms)[0] } : null; } });
    if (!def) return null;
    const b = blendOf(m);
    return {
      id: def.id,
      points: !!def.points,
      lines: !!def.lines,
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
  /** Atributos que entran en la clave de una geometria, en orden fijo (sin crear arrays: se compara en cada dibujo). */
  private static readonly GEOM_ATTRS = ['position', 'normal', 'uv', 'color', 'skinIndex', 'skinWeight'];

  /** ¿La geometria sigue igual que cuando se subio? Compara referencia, version y numero de elementos sin construir la clave de texto. */
  private sameGeom(rec: { snap?: any[]; lm?: number }, g: any, lineMode: number): boolean {
    const s = rec.snap;
    if (!s || rec.lm !== lineMode) return false;
    const at = g.attributes, names = WebGLRenderer.GEOM_ATTRS;
    for (let i = 0; i < 6; i++) {
      const a = at[names[i]];
      if (s[i * 3] !== a) return false;
      if (a && (s[i * 3 + 1] !== (a.data ?? a).version || s[i * 3 + 2] !== a.count)) return false;
    }
    const ix = g.index;
    return s[18] === ix && (!ix || (s[19] === ix.version && s[20] === ix.count));
  }

  private snapGeom(rec: { snap?: any[]; lm?: number }, g: any, lineMode: number) {
    const s: any[] = [], at = g.attributes, names = WebGLRenderer.GEOM_ATTRS;
    for (let i = 0; i < 6; i++) {
      const a = at[names[i]];
      s.push(a, a ? (a.data ?? a).version : 0, a ? a.count : 0);
    }
    const ix = g.index;
    s.push(ix, ix ? ix.version : 0, ix ? ix.count : 0);
    rec.snap = s;
    rec.lm = lineMode;
  }

  private geomId(g: any, slots?: { normal?: string[]; uv?: string[]; color?: string[] } | null, lineMode = 0): number {
    const fast: any = !slots && this.ids.get(g);
    if (fast && this.sameGeom(fast, g, lineMode)) return fast.id;
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
    const aid = (a: any) => {
      if (!a) return 0;
      let i = this.attrIds.get(a);
      if (!i) this.attrIds.set(a, (i = this.nextAttr++));
      return `${i}.${(a.data ?? a).version}.${a.count}`;
    };
    const slotKey = slots ? ['normal', 'uv', 'color'].map((k) => (slots[k] ?? []).map((n) => aid(g.attributes[n])).join('+')).join('/') : '';
    const key = `${aid(pos)}:${aid(nor)}:${aid(uv)}:${aid(col)}:${aid(g.index)}:${aid(g.attributes.skinIndex)}:${aid(g.attributes.skinWeight)}:${slotKey}:L${lineMode}`;
    let rec: any = this.ids.get(g);
    if (rec && rec.key === key) return (slots ? (rec.snap = undefined) : this.snapGeom(rec, g, lineMode), rec.id);
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
    if (lineMode) {
      // Line (tira) y LineLoop: la tira se expande a pares de la lista de lineas
      const n = g.index ? g.index.count : pos.count, at = (i: number) => (g.index ? g.index.array[i] : i), segs = Math.max(0, lineMode === 2 ? n : n - 1);
      index = new Uint32Array(segs * 2);
      for (let i = 0; i < segs; i++) (index[i * 2] = at(i)), (index[i * 2 + 1] = at((i + 1) % n));
    } else if (g.index) index = g.index.array instanceof Uint32Array ? g.index.array : Uint32Array.from(g.index.array);
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
    if (slots) rec.snap = undefined;
    else this.snapGeom(rec, g, lineMode);
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
    const vp = this.rt ? this.rt.viewport : null;
    this.emitPass(def.id, new Float32Array(def.pack(m, { viewport: vp ? [vp.x, vp.y, vp.z, vp.w] : [0, 0, 0, 0] })), new Uint32Array(blendOf(m)), new Uint32Array(tex));
    const err = this.gl.take_error();
    if (err) console.error('[phoenyx] GPU:', err);
  }

  /** Llama a `onBeforeRender` de los objetos que lo definen y pasan visibilidad, capas y frustum (como projectObject de three). */
  private runBeforeRender(scene: any, camera: any) {
    if (scene.matrixWorldAutoUpdate === true) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate === true) camera.updateMatrixWorld();
    let frustumReady = false;
    const visit = (o: any) => {
      if (o.visible === false) return;
      if (o.onBeforeRender !== Object3D.prototype.onBeforeRender && o.layers.test(camera.layers)) {
        let ok = true;
        if (o.frustumCulled && (o.isMesh || o.isLine || o.isPoints)) {
          if (!frustumReady) {
            this.hookFrustum.setFromProjectionMatrix(this.hookMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
            frustumReady = true;
          }
          ok = this.hookFrustum.intersectsObject(o);
        }
        if (ok) o.onBeforeRender(this, scene, camera, o.geometry, o.material, null);
      }
      for (const c of o.children) visit(c);
    };
    visit(scene);
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
    // onBeforeRender de los objetos visibles (el Reflector dibuja aqui su textura): antes de empaquetar, para que el render anidado
    // termine entero (su propio pack y su propio frame) y deje el destino como estaba
    this.depth++;
    try {
      this.runBeforeRender(scene, camera);
    } finally {
      this.depth--;
    }
    this.gl.resize(this.domElement.width, this.domElement.height);
    this.syncTarget();
    const rtOut = !!this.rt;
    if (this.info.autoReset && this.depth === 0) this.info.reset();
    // fondo: scene.background (Color) o el color de limpieza, convertido al espacio de salida como hace three
    const rgb = { r: 0, g: 0, b: 0 };
    const forceClear = !!(scene.background && scene.background.isColor);
    const bg = forceClear ? scene.background : this.clearColor;
    const space = rtOut ? LinearSRGBColorSpace : this.outputColorSpace;
    bg.getRGB(rgb, space);
    const alpha = scene.background && scene.background.isColor ? 1 : this.clearAlpha;
    const tm = !rtOut && this.toneMapping === ACESFilmicToneMapping ? 1 : 0;
    if (!rtOut && this.toneMapping !== NoToneMapping && this.toneMapping !== ACESFilmicToneMapping) console.warn('[phoenyx] solo esta soportado ACESFilmicToneMapping');
    // scene.environment (textura PMREM en formato CubeUV, de PMREMGenerator): solo la usan los materiales estandar
    const envTex = scene.isScene ? scene.environment : null;
    const envId = envTex && envTex.mapping === CubeUVReflectionMapping ? this.textures.idOf(envTex) : 0;
    this.gl.set_environment(envId ? envId : 0xffffffff);
    this.renderCount++;
    const p = this.packer.pack(scene, camera, { matricesDone: true, env: !!envId, exposure: this.toneMappingExposure, toneMapping: tm, clear: [rgb.r, rgb.g, rgb.b, alpha], outputColorSpace: space, linear: rtOut, // con scene.background (Color) three limpia siempre, segun autoClearColor/autoClearDepth aunque autoClear sea false
 clearFlags: forceClear ? (this.autoClearColor ? 1 : 0) | (this.autoClearDepth ? 2 : 0) : this.autoClear ? (this.autoClearColor ? 1 : 0) | (this.autoClearDepth ? 2 : 0) : 0, size: rtOut ? [Math.max(1, Math.floor(this.rt.width)), Math.max(1, Math.floor(this.rt.height))] : [this.domElement.width, this.domElement.height], shadow: this.shadowMap }, (g, slots, lm) => this.geomId(g, slots, lm), (m) => this.textures.materialKey(m), (o) => this.instInfo(o), (o) => this.boneInfo(o), (m) => this.userInfo(m), (m) => this.patchInfo(m));
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
    this.setAnimationLoop(null);
    this.disposed = true;
    this.textures?.release();
    if (this.gl) {
      this.gl.destroy();
      this.gl.free();
    }
    this.gl = null;
  }
}
