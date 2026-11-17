// WebGLRenderer de Phoenyx: misma API que el de three (la parte que usa el juego), dibujando con phoenyx-gl (WebGPU).
// @ts-nocheck (usa el JS de three copiado)
import { UniformsLib } from './three/renderers/shaders/UniformsLib.js';
import init, { create } from '../pkg/phoenyx_gl.js';
import { Packer } from './pack';
import { TextureCache } from './textures';
import { Color } from './three/math/Color.js';
import { BufferGeometry } from './three/core/BufferGeometry.js';
import { ACESFilmicToneMapping, NoToneMapping, SRGBColorSpace } from './three/constants.js';

/** Si el anfitrion no sirve el wasm junto al modulo, define `globalThis.PHOENYX_WASM_URL` antes de crear el renderer. */
const wasmUrl = () => (globalThis as any).PHOENYX_WASM_URL;

export class WebGLRenderer {
  domElement: HTMLCanvasElement;
  outputColorSpace = SRGBColorSpace;
  toneMapping = NoToneMapping;
  toneMappingExposure = 1;
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

  /** Normales de una geometria que no las trae (sin tocar la geometria del juego). */
  private normalsOf(g: any): Float32Array {
    const t = new BufferGeometry();
    t.setAttribute('position', g.attributes.position);
    if (g.index) t.setIndex(g.index);
    t.computeVertexNormals();
    return t.attributes.normal.array as Float32Array;
  }

  /** Sube la geometria a la GPU si es nueva o cambio (version de sus atributos) y devuelve su id. */
  private geomId(g: any): number {
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
    const aid = (a: any) => {
      if (!a) return 0;
      let i = this.attrIds.get(a);
      if (!i) this.attrIds.set(a, (i = this.nextAttr++));
      return `${i}.${(a.data ?? a).version}.${a.count}`;
    };
    const key = `${aid(pos)}:${aid(nor)}:${aid(uv)}:${aid(col)}:${aid(g.index)}`;
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
    this.gl.set_geometry(rec.id, f32(pos, 3), nor ? f32(nor, 3) : this.normalsOf(g), f32(uv, 2), f32(g.attributes.color, 3), index);
    return rec.id;
  }

  render(scene: any, camera: any) {
    if (!this.gl) return;
    if (this.gl.is_lost()) {
      if (!this.lostReported) (this.lostReported = true), console.error('[phoenyx] dispositivo GPU perdido:', this.gl.take_error());
      return;
    }
    this.gl.resize(this.domElement.width, this.domElement.height);
    if (this.info.autoReset) this.info.reset();
    // fondo: scene.background (Color) o el color de limpieza, convertido al espacio de salida como hace three
    const rgb = { r: 0, g: 0, b: 0 };
    const bg = scene.background && scene.background.isColor ? scene.background : this.clearColor;
    bg.getRGB(rgb, this.outputColorSpace);
    const alpha = scene.background && scene.background.isColor ? 1 : this.clearAlpha;
    const tm = this.toneMapping === ACESFilmicToneMapping ? 1 : 0;
    if (this.toneMapping !== NoToneMapping && !tm) console.warn('[phoenyx] solo esta soportado ACESFilmicToneMapping');
    const p = this.packer.pack(scene, camera, { exposure: this.toneMappingExposure, toneMapping: tm, clear: [rgb.r, rgb.g, rgb.b, alpha], outputColorSpace: this.outputColorSpace, shadow: this.shadowMap }, (g) => this.geomId(g), (m) => this.textures.materialKey(m), (o) => this.instInfo(o));
    // tablas LTC de RectAreaLight: las deja RectAreaLightUniformsLib.init() en UniformsLib
    if (!this.ltcDone && UniformsLib.LTC_FLOAT_1) {
      this.gl.set_ltc(UniformsLib.LTC_FLOAT_1.image.data, UniformsLib.LTC_FLOAT_2.image.data);
      this.ltcDone = true;
    }
    if (p.shadowAlloc) this.gl.set_shadow_maps(p.shadowAlloc[0], p.shadowAlloc[1]);
    this.gl.frame(p.globals, p.objects, p.materials, p.lights, p.draws, p.shadows, p.shadowPasses, p.nDraws);
    if (p.shadowRan) this.shadowMap.needsUpdate = false;
    const err = this.gl.take_error();
    if (err) console.error('[phoenyx] GPU:', err);
    this.info.render.calls += p.nDraws;
    this.info.render.triangles += p.triangles;
    this.info.render.frame++;
    this.info.memory.textures = this.textures.count;
  }

  dispose() {
    this.disposed = true;
    this.gl?.free?.();
    this.gl = null;
  }
}
