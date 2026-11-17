// Recorre el grafo de three y lo empaqueta en los arrays tipados que lee phoenyx-gl (formatos en docs/FASE1.md).
// Replica las reglas de WebGLRenderer.projectObject y WebGLRenderLists de three 0.160.1: visibilidad, capas, frustum,
// orden de dibujo (opacos: grupo, renderOrder, material, z; transparentes: grupo, renderOrder, z invertida) y las dos pasadas
// de los materiales transparentes de doble cara.
// @ts-nocheck (usa el JS de three copiado)
import { Frustum } from './three/math/Frustum.js';
import { Matrix3 } from './three/math/Matrix3.js';
import { Matrix4 } from './three/math/Matrix4.js';
import { Vector3 } from './three/math/Vector3.js';
import { BackSide, DoubleSide, FrontSide } from './three/constants.js';

export const GLOBALS_F = 64;
export const OBJECT_F = 32;
export const MATERIAL_F = 12;
export const LIGHT_F = 16;
export const MAX_LIGHTS = 64;

interface Item {
  object: any;
  geometry: any;
  material: any;
  groupOrder: number;
  renderOrder: number;
  z: number;
  id: number;
}

export interface Packed {
  globals: Float32Array;
  objects: Float32Array;
  materials: Float32Array;
  lights: Float32Array;
  draws: Uint32Array;
  nDraws: number;
  triangles: number;
}

export interface FrameState {
  exposure: number;
  toneMapping: number;
  /** color de fondo ya en el espacio de salida (lo que three manda a gl.clearColor) */
  clear: [number, number, number, number];
  outputColorSpace: string;
}

const painterSortStable = (a: Item, b: Item) =>
  a.groupOrder !== b.groupOrder ? a.groupOrder - b.groupOrder
  : a.renderOrder !== b.renderOrder ? a.renderOrder - b.renderOrder
  : a.material.id !== b.material.id ? a.material.id - b.material.id
  : a.z !== b.z ? a.z - b.z
  : a.id - b.id;

const reversePainterSortStable = (a: Item, b: Item) =>
  a.groupOrder !== b.groupOrder ? a.groupOrder - b.groupOrder
  : a.renderOrder !== b.renderOrder ? a.renderOrder - b.renderOrder
  : a.z !== b.z ? b.z - a.z
  : a.id - b.id;

const warned = new Set<string>();
const warnOnce = (k: string, msg: string) => {
  if (!warned.has(k)) (warned.add(k), console.warn('[phoenyx] ' + msg));
};

export class Packer {
  private frustum = new Frustum();
  private projScreen = new Matrix4();
  private mv = new Matrix4();
  private nm = new Matrix3();
  private v = new Vector3();
  private opaque: Item[] = [];
  private transparent: Item[] = [];
  private lights: any[] = [];

  pack(scene: any, camera: any, st: FrameState, geomId: (geometry: any) => number): Packed {
    if (scene.matrixWorldAutoUpdate === true) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate === true) camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    this.opaque.length = this.transparent.length = this.lights.length = 0;
    this.project(scene, camera, 0);
    this.opaque.sort(painterSortStable);
    this.transparent.sort(reversePainterSortStable);

    // materiales y objetos: una entrada por dibujo
    const mats = new Map<any, number>();
    const matData: number[] = [];
    const matIndex = (m: any) => {
      let i = mats.get(m);
      if (i === undefined) {
        i = mats.size;
        mats.set(m, i);
        const c = m.color, e = m.emissive;
        const k = m.emissiveIntensity ?? 1;
        const std = m.isMeshStandardMaterial ? 1 : 0;
        matData.push(c.r, c.g, c.b, m.opacity, e && std ? e.r * k : 0, e && std ? e.g * k : 0, e && std ? e.b * k : 0, std ? m.roughness : 1, std ? m.metalness : 0, std, m.fog === false ? 0 : 1, 0);
      }
      return i;
    };

    const list = [...this.opaque, ...this.transparent];
    const objs = new Float32Array(list.length * 2 * OBJECT_F); // hasta 2 dibujos por objeto, comparten registro
    const draws: number[] = [];
    let triangles = 0;
    let no = 0;
    for (const it of list) {
      const o = it.object, m = it.material;
      if (m.visible === false) continue;
      this.mv.multiplyMatrices(camera.matrixWorldInverse, o.matrixWorld);
      this.nm.getNormalMatrix(this.mv);
      const base = no * OBJECT_F;
      objs.set(o.matrixWorld.elements, base);
      const n = this.nm.elements;
      objs.set([n[0], n[1], n[2], 0, n[3], n[4], n[5], 0, n[6], n[7], n[8], 0], base + 16);
      const gid = geomId(it.geometry);
      const mi = matIndex(m);
      // como three (state.setMaterial): se descarta siempre la cara trasera; BackSide y el determinante negativo invierten el giro
      const flip = o.matrixWorld.determinant() < 0;
      const common = (m.transparent ? 4 : 0) | (m.depthWrite !== false && m.depthTest !== false ? 8 : 0) | (m.depthTest !== false ? 16 : 0);
      const idx = it.geometry.index ? it.geometry.index.count : it.geometry.attributes.position.count;
      const bits = (backSide: boolean, double: boolean, normalDouble: boolean) =>
        common | (double ? 1 : 0) | (backSide !== flip ? 2 : 0) | (backSide ? 32 : 0) | (normalDouble ? 64 : 0);
      if (m.transparent && m.side === DoubleSide) {
        // transparente de doble cara: primero las traseras (material BackSide), luego las frontales
        draws.push(gid, no, mi, bits(true, false, false), gid, no, mi, bits(false, false, false));
        triangles += (idx / 3) * 2;
      } else {
        draws.push(gid, no, mi, bits(m.side === BackSide, m.side === DoubleSide, m.side === DoubleSide));
        triangles += idx / 3;
      }
      no++;
    }

    // luces: puntuales primero y luego direccionales (el orden de los bucles de lights_fragment_begin)
    const view = camera.matrixWorldInverse;
    const lightData: number[] = [];
    const amb = [0, 0, 0];
    const v = this.v;
    let count = 0;
    for (const type of ['point', 'directional']) {
      for (const l of this.lights) {
        const k = l.intensity;
        if (l.isAmbientLight) {
          if (type === 'point') (amb[0] += l.color.r * k, amb[1] += l.color.g * k, amb[2] += l.color.b * k);
        } else if (type === 'point' && l.isPointLight) {
          if (count++ >= MAX_LIGHTS) continue;
          v.setFromMatrixPosition(l.matrixWorld).applyMatrix4(view);
          lightData.push(1, l.color.r * k, l.color.g * k, l.color.b * k, v.x, v.y, v.z, l.distance, l.decay, 0, 0, 0, 0, 0, 0, 0);
        } else if (type === 'directional' && l.isDirectionalLight) {
          if (count++ >= MAX_LIGHTS) continue;
          v.setFromMatrixPosition(l.matrixWorld);
          const t = new Vector3().setFromMatrixPosition(l.target.matrixWorld);
          v.sub(t).transformDirection(view);
          lightData.push(0, l.color.r * k, l.color.g * k, l.color.b * k, 0, 0, 0, 0, 0, v.x, v.y, v.z, 0, 0, 0, 0);
        } else if (type === 'point' && !l.isPointLight && !l.isDirectionalLight) {
          warnOnce(l.type, `la luz ${l.type} aun no esta soportada y se ignora`);
        }
      }
    }
    if (count > MAX_LIGHTS) warnOnce('maxlights', `hay ${count} luces y el maximo es ${MAX_LIGHTS}: sobran ${count - MAX_LIGHTS}`);

    // globales
    const g = new Float32Array(GLOBALS_F);
    g.set(view.elements, 0);
    g.set(camera.projectionMatrix.elements, 16);
    g[32] = camera.matrixWorld.elements[12];
    g[33] = camera.matrixWorld.elements[13];
    g[34] = camera.matrixWorld.elements[14];
    g[35] = st.exposure;
    g[36] = st.toneMapping;
    const fog = scene.fog;
    if (fog) {
      g[37] = fog.isFogExp2 ? 2 : 1;
      g[38] = fog.near ?? 0;
      g[39] = fog.far ?? 0;
      // refreshFogUniforms: el color de la niebla va en el espacio de salida, porque se mezcla despues de codificar
      const fc = { r: 0, g: 0, b: 0 };
      fog.color.getRGB(fc, st.outputColorSpace);
      g[40] = fc.r;
      g[41] = fc.g;
      g[42] = fc.b;
      g[43] = fog.density ?? 0;
    }
    g.set(st.clear, 44);
    g[52] = amb[0];
    g[53] = amb[1];
    g[54] = amb[2];
    g[48] = 0;
    g[51] = camera.isOrthographicCamera ? 1 : 0;
    g[50] = Math.min(count, MAX_LIGHTS);

    return {
      globals: g,
      objects: objs.subarray(0, no * OBJECT_F),
      materials: new Float32Array(matData),
      lights: new Float32Array(lightData),
      draws: new Uint32Array(draws),
      nDraws: draws.length / 4,
      triangles,
    };
  }

  /** WebGLRenderer.projectObject: visibilidad, capas, frustum y cola opaca/transparente. */
  private project(object: any, camera: any, groupOrder: number) {
    if (object.visible === false) return;
    if (object.layers.test(camera.layers)) {
      if (object.isGroup) groupOrder = object.renderOrder;
      else if (object.isLOD) {
        if (object.autoUpdate === true) object.update(camera);
      } else if (object.isLight) this.lights.push(object);
      else if (object.isMesh) {
        if (object.isSkinnedMesh || object.isInstancedMesh) warnOnce(object.type, `${object.type} aun no esta soportado y se dibuja como Mesh`);
        if (!object.frustumCulled || this.frustum.intersectsObject(object)) {
          const material = object.material;
          if (Array.isArray(material)) warnOnce('multimat', 'materiales multiples aun no estan soportados: se usa el primero');
          const mat = Array.isArray(material) ? material[0] : material;
          if (mat && mat.visible !== false) {
            // z de ordenacion: centro de la esfera envolvente, como WebGLRenderer.projectObject
            const geo = object.geometry;
            if (object.boundingSphere !== undefined) {
              if (object.boundingSphere === null) object.computeBoundingSphere();
              this.v.copy(object.boundingSphere.center);
            } else {
              if (geo.boundingSphere === null) geo.computeBoundingSphere();
              this.v.copy(geo.boundingSphere.center);
            }
            this.v.applyMatrix4(object.matrixWorld).applyMatrix4(this.projScreen);
            const item: Item = { object, geometry: object.geometry, material: mat, groupOrder, renderOrder: object.renderOrder, z: this.v.z, id: object.id };
            (mat.transparent ? this.transparent : this.opaque).push(item);
          }
        }
      } else if (object.isPoints || object.isLine || object.isSprite) warnOnce(object.type, `${object.type} aun no esta soportado y se omite`);
    }
    for (const c of object.children) this.project(c, camera, groupOrder);
  }
}
