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
export const MATERIAL_F = 64;
export const LIGHT_F = 16;
export const MAX_LIGHTS = 64;
export const SHADOW_F = 48;
/** Luces con sombra a la vez (una capa del mapa de sombras por luz). */
export const MAX_SHADOWS = 4;

interface Item {
  object: any;
  geometry: any;
  material: any;
  groupOrder: number;
  renderOrder: number;
  z: number;
  id: number;
  group: { start: number; count: number } | null;
}

export interface Packed {
  globals: Float32Array;
  objects: Float32Array;
  materials: Float32Array;
  lights: Float32Array;
  draws: Uint32Array;
  /** dibujos de la escena; el resto de `draws` son los de las pasadas de sombras */
  nDraws: number;
  shadows: Float32Array;
  /** [capa, primer dibujo, n dibujos, ancho, alto] por mapa que se repinta */
  shadowPasses: Uint32Array;
  /** si cambia hace falta reservar de nuevo los mapas (capas, lado) */
  shadowAlloc: [number, number] | null;
  /** la pasada de sombras se ejecuto (three entonces baja shadowMap.needsUpdate) */
  shadowRan: boolean;
  triangles: number;
}

export interface FrameState {
  exposure: number;
  toneMapping: number;
  /** color de fondo ya en el espacio de salida (lo que three manda a gl.clearColor) */
  clear: [number, number, number, number];
  outputColorSpace: string;
  /** dibujo a un render target: salida lineal, sin tone mapping ni codificacion sRGB (como three con renderTarget != null) */
  linear?: boolean;
  /** bit 0: limpiar color, bit 1: limpiar profundidad (autoClear de three) */
  clearFlags?: number;
  shadow: { enabled: boolean; type: number; autoUpdate: boolean; needsUpdate: boolean };
}

const WHITE = { r: 1, g: 1, b: 1 };

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

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const warned = new Set<string>();
/** La imagen ya esta cargada (three muestra negro hasta entonces; aqui el bit de mapa solo se activa cuando se puede subir). */
const textureReady = (t: any) => { const i = t.image; return !!i && (!!i.data || (i.complete !== false && !!(i.naturalWidth || i.videoWidth || i.width))); };
const warnOnce = (k: string, msg: string) => {
  if (!warned.has(k)) (warned.add(k), console.warn('[phoenyx] ' + msg));
};

export class Packer {
  private frustum = new Frustum();
  private projScreen = new Matrix4();
  private mv = new Matrix4();
  private m4 = new Matrix4();
  private m42 = new Matrix4();
  private nm = new Matrix3();
  private v = new Vector3();
  private opaque: Item[] = [];
  private transparent: Item[] = [];
  private lights: any[] = [];
  private sLayers = 0;
  /** capa de mapa de sombra estable por luz (una luz que desaparece no desplaza a las demas) */
  private layerOf = new Map<any, number>();
  /** repintar todos los mapas el proximo fotograma (el anterior no llego a dibujarse) */
  forceShadows = false;
  private sSize = 0;

  pack(scene: any, camera: any, st: FrameState, geomId: (geometry: any) => number, texKey: (material: any) => number, instInfo: (object: any) => { id: number; count: number; color: boolean } | null, boneInfo: (object: any) => number): Packed {
    if (scene.matrixWorldAutoUpdate === true) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate === true) camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    // scene.overrideMaterial: solo MeshNormalMaterial (lo usa GTAOPass para las normales); se ordena por el material de cada objeto y se dibuja con el del override
    let ov = scene.isScene ? scene.overrideMaterial : null;
    if (ov && !ov.isMeshNormalMaterial) (warnOnce('override-' + ov.type, `overrideMaterial ${ov.type} aun no esta soportado y se ignora`), (ov = null));
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
        const c = m.color ?? WHITE, e = m.emissive;
        const k = m.emissiveIntensity ?? 1;
        const std = m.isMeshStandardMaterial ? 1 : 0;
        const maps = [m.map, std ? m.normalMap : null, std ? m.roughnessMap : null, std ? m.emissiveMap : null, std ? m.bumpMap : null];
        let mask = 0;
        const uv: number[] = [];
        maps.forEach((t, j) => {
          if (t && t.image && textureReady(t)) mask |= 1 << j;
          if (t && t.matrixAutoUpdate === true) t.updateMatrix();
          const e = t ? t.matrix.elements : IDENT;
          uv.push(e[0], e[1], e[3], e[4], e[6], e[7], 0, 0);
        });
        // metalnessMap solo se admite si es la misma textura que roughnessMap (asi las emite GLTFLoader)
        if (std && m.metalnessMap && m.metalnessMap === m.roughnessMap && m.roughnessMap.image) mask |= 32;
        const ns = m.normalScale;
        matData.push(
          c.r, c.g, c.b, m.opacity,
          e && std ? e.r * k : 0, e && std ? e.g * k : 0, e && std ? e.b * k : 0, std ? m.roughness : 1,
          std ? m.metalness : 0, m.isMeshNormalMaterial ? 2 : std, m.fog === false || m.isMeshNormalMaterial ? 0 : 1, m.vertexColors ? 1 : 0,
          m.alphaTest > 0 ? m.alphaTest : 0, ns ? ns.x : 1, ns ? ns.y : 1, m.bumpScale ?? 1,
          mask, 0, 0, 0,
          ...uv,
          0, 0, 0, 0,
        );
      }
      return i;
    };

    // sombras (WebGLShadowMap.render): luces con castShadow, ya sea por foco o direccional; los mapas se repintan segun autoUpdate/needsUpdate
    const sh = st.shadow;
    const shadowLights: any[] = [];
    if (sh.enabled && !ov) {
      for (const l of this.lights) {
        if (!l.castShadow || !l.shadow) continue;
        if (!l.isSpotLight && !l.isDirectionalLight) warnOnce('shadow-' + l.type, `la sombra de ${l.type} aun no esta soportada`);
        else if (shadowLights.length < MAX_SHADOWS) shadowLights.push(l);
        else warnOnce('maxshadows', `hay mas de ${MAX_SHADOWS} luces con sombra: sobran`);
      }
    }
    // capas estables: las luces que siguen conservan su capa; las nuevas toman una libre y se pintan aunque no lo pidan sus banderas
    if (!ov) for (const l of [...this.layerOf.keys()]) if (!shadowLights.includes(l)) this.layerOf.delete(l);
    const fresh = new Set<any>();
    for (const l of shadowLights) {
      if (this.layerOf.has(l)) continue;
      const used = new Set(this.layerOf.values());
      let c = 0;
      while (used.has(c)) c++;
      this.layerOf.set(l, c);
      fresh.add(l);
    }
    const nLayers = shadowLights.reduce((n, l) => Math.max(n, this.layerOf.get(l)! + 1), 0);
    // como WebGLShadowMap.render: sin luces con sombra no se hace nada (y needsUpdate se conserva)
    const shadowRan = sh.enabled && !ov && shadowLights.length > 0 && (sh.autoUpdate || sh.needsUpdate);
    let sSize = this.sSize;
    for (const l of shadowLights) sSize = Math.max(sSize, l.shadow.mapSize.x, l.shadow.mapSize.y);
    const sLayers = Math.max(this.sLayers, nLayers);
    const shadowAlloc: [number, number] | null = shadowLights.length && (sLayers !== this.sLayers || sSize !== this.sSize) ? [sLayers, sSize] : null;
    if (shadowAlloc) (this.sLayers = sLayers, this.sSize = sSize);
    // un mapa recien reservado esta vacio (profundidad 0 = todo en sombra): se pinta siempre
    const force = shadowLights.length > 0 && (this.forceShadows || !!shadowAlloc);
    if (!ov) this.forceShadows = false;
    const shadowCasters: Array<Array<{ object: any; geometry: any; material: any; group: any }> | null> = shadowLights.map((l) => {
      if (!force && !fresh.has(l) && !(shadowRan && (l.shadow.autoUpdate || l.shadow.needsUpdate))) return null;
      l.shadow.updateMatrices(l);
      const out: Array<{ object: any; geometry: any; material: any; group: any }> = [];
      this.collectCasters(scene, camera, l.shadow.getFrustum(), out);
      return out;
    });
    const extraObjs = shadowCasters.reduce((n, c) => n + (c ? c.length : 0), 0);

    const list = [...this.opaque, ...this.transparent];
    const objs = new Float32Array((list.length * 2 + extraObjs) * OBJECT_F); // hasta 2 dibujos por objeto, comparten registro
    const draws: number[] = [];
    let triangles = 0;
    let no = 0;
    const objRec = new Map<any, number>();
    for (const it of list) {
      const o = it.object, m = ov ?? it.material;
      // como renderBufferDirect: sin posicion no se dibuja; materiales sin color (Shader, Depth...) aun no se soportan
      const gp = it.geometry.attributes.position;
      if (!gp || gp.count === 0) continue;
      if (!m.color && !m.isMeshNormalMaterial) { warnOnce(m.type, `${m.type} aun no esta soportado y se omite`); continue; }
      this.mv.multiplyMatrices(camera.matrixWorldInverse, o.matrixWorld);
      this.nm.getNormalMatrix(this.mv);
      const base = no * OBJECT_F;
      if (!objRec.has(o)) objRec.set(o, no);
      objs.set(o.matrixWorld.elements, base);
      const n = this.nm.elements;
      objs.set([n[0], n[1], n[2], 0, n[3], n[4], n[5], 0, n[6], n[7], n[8], 0], base + 16);
      const gid = geomId(it.geometry);
      const tk = texKey(m);
      const mi = matIndex(m);
      const ii = o.isInstancedMesh ? instInfo(o) : null;
      if (o.isInstancedMesh && (!ii || ii.count === 0)) continue;
      // malla con piel: su tramo de huesos (0 = sin piel; sin skinIndex/skinWeight se dibuja como Mesh)
      const bk = o.isSkinnedMesh && it.geometry.attributes.skinIndex && it.geometry.attributes.skinWeight ? boneInfo(o) : 0;
      // como three (state.setMaterial): se descarta siempre la cara trasera; BackSide y el determinante negativo invierten el giro
      const flip = o.matrixWorld.determinant() < 0;
      const common = (o.receiveShadow ? 256 : 0) | (m.transparent ? 4 : 0) | (m.depthWrite !== false && m.depthTest !== false ? 8 : 0) | (m.depthTest !== false ? 16 : 0);
      // rango de dibujo: drawRange y grupo, como WebGLRenderer.renderBufferDirect
      const geo = it.geometry;
      const dataCount = geo.index ? geo.index.count : geo.attributes.position.count;
      const gs = it.group ? it.group.start : 0, gc = it.group ? it.group.count : Infinity;
      const first = Math.max(geo.drawRange.start, gs);
      const idx = Math.max(0, Math.min(dataCount, geo.drawRange.start + geo.drawRange.count, gs + gc) - first);
      if (idx === 0) continue;
      const bits = (backSide: boolean, double: boolean, normalDouble: boolean) =>
        common | (double ? 1 : 0) | (backSide !== flip ? 2 : 0) | (backSide ? 32 : 0) | (normalDouble ? 64 : 0);
      const emit = (fl: number) => {
        if (!ii) {
          draws.push(gid, no, mi, fl, first, idx, tk, 0xffffffff, 1, 0, 0, bk);
          triangles += idx / 3;
        } else {
          // una malla con mas de 65535 instancias se parte en varios dibujos (instance_index lleva 16 bits de instancia)
          for (let s = 0; s < ii.count; s += 65535) {
            const n = Math.min(65535, ii.count - s);
            draws.push(gid, no, mi, fl | (ii.color ? 128 : 0), first, idx, tk, ii.id, n, s, 0, 0);
            triangles += (idx / 3) * n;
          }
        }
      };
      if (m.transparent && m.side === DoubleSide && !m.forceSinglePass) {
        // transparente de doble cara: primero las traseras (material BackSide), luego las frontales
        emit(bits(true, false, false));
        emit(bits(false, false, false));
      } else {
        emit(bits(m.side === BackSide, m.side === DoubleSide, m.side === DoubleSide));
      }
      no++;
    }

    // dibujos de las pasadas de sombras, a continuacion de los de la escena (comparten buffers de objetos, geometrias y materiales)
    const mainDraws = draws.length / 12;
    const shadowData = new Float32Array(Math.max(1, nLayers) * SHADOW_F);
    const shadowPasses: number[] = [];
    shadowLights.forEach((l, li) => {
      const layer = this.layerOf.get(l)!;
      const shadow = l.shadow;
      const casters = shadowCasters[li];
      const vp = new Matrix4().multiplyMatrices(shadow.camera.projectionMatrix, shadow.camera.matrixWorldInverse);
      const b = layer * SHADOW_F;
      shadowData.set(shadow.matrix.elements, b);
      shadowData.set(vp.elements, b + 16);
      shadowData.set([shadow.bias, shadow.normalBias, shadow.radius, shadow.mapSize.x, shadow.mapSize.y], b + 32);
      if (!casters) return;
      const start = draws.length / 12;
      for (const it of casters) {
        const o = it.object, m = it.material, geo = it.geometry;
        const ii = o.isInstancedMesh ? instInfo(o) : null;
        if (o.isInstancedMesh && (!ii || ii.count === 0)) continue;
        let rec = objRec.get(o);
        if (rec === undefined) {
          rec = no++;
          objRec.set(o, rec);
          objs.set(o.matrixWorld.elements, rec * OBJECT_F);
        }
        const dataCount = geo.index ? geo.index.count : geo.attributes.position.count;
        const gs = it.group ? it.group.start : 0, gc = it.group ? it.group.count : Infinity;
        const first = Math.max(geo.drawRange.start, gs);
        const idx = Math.max(0, Math.min(dataCount, geo.drawRange.start + geo.drawRange.count, gs + gc) - first);
        if (idx === 0) continue;
        const gid = geomId(geo);
        const tk = texKey(m);
        const mi = matIndex(m);
        // shadowSide como WebGLShadowMap.getDepthMaterial: FrontSide proyecta con las caras traseras y al reves
        const side = m.shadowSide != null ? m.shadowSide : m.side === FrontSide ? BackSide : m.side === BackSide ? FrontSide : DoubleSide;
        const flip = o.matrixWorld.determinant() < 0;
        const alpha = m.alphaTest > 0 && m.map && textureReady(m.map) ? 512 : 0;
        const fl = (side === DoubleSide ? 1 : 0) | ((side === BackSide) !== flip ? 2 : 0) | alpha;
        const bk = o.isSkinnedMesh && geo.attributes.skinIndex && geo.attributes.skinWeight ? boneInfo(o) : 0;
        if (!ii) draws.push(gid, rec, mi, fl, first, idx, tk, 0xffffffff, 1, 0, layer, bk);
        else for (let s0 = 0; s0 < ii.count; s0 += 65535) draws.push(gid, rec, mi, fl, first, idx, tk, ii.id, Math.min(65535, ii.count - s0), s0, layer, 0);
      }
      shadowPasses.push(layer, start, draws.length / 12 - start, shadow.mapSize.x, shadow.mapSize.y);
      shadow.needsUpdate = false;
    });

    if (draws.length / 12 > 65536) warnOnce('maxdraws', 'mas de 65536 dibujos entre escena y sombras: los sobrantes no se pintan');

    // luces: puntuales primero y luego direccionales (el orden de los bucles de lights_fragment_begin)
    const view = camera.matrixWorldInverse;
    const lightData: number[] = [];
    const amb = [0, 0, 0];
    const v = this.v;
    let count = 0;
    // orden de lights_fragment_begin: puntuales, focos, direccionales; el hemisferio y el ambiente van al final (indirecto)
    const hemi: number[] = [];
    for (const type of ['point', 'spot', 'rect', 'directional', 'rest']) {
      for (const l of this.lights) {
        const k = l.intensity;
        if (type === 'rest') {
          if (l.isAmbientLight) (amb[0] += l.color.r * k, amb[1] += l.color.g * k, amb[2] += l.color.b * k);
          else if (l.isHemisphereLight) {
            if (count++ >= MAX_LIGHTS) continue;
            // la direccion es la posicion de la luz (y arriba por defecto) en vista, como WebGLLights
            v.setFromMatrixPosition(l.matrixWorld).transformDirection(view);
            hemi.push(2, l.color.r * k, l.color.g * k, l.color.b * k, l.groundColor.r * k, l.groundColor.g * k, l.groundColor.b * k, 0, 0, v.x, v.y, v.z, 0, 0, 0, 0);
          } else if (!l.isPointLight && !l.isSpotLight && !l.isDirectionalLight && !l.isRectAreaLight) warnOnce(l.type, `la luz ${l.type} aun no esta soportada y se ignora`);
        } else if (type === 'point' && l.isPointLight) {
          if (count++ >= MAX_LIGHTS) continue;
          v.setFromMatrixPosition(l.matrixWorld).applyMatrix4(view);
          lightData.push(1, l.color.r * k, l.color.g * k, l.color.b * k, v.x, v.y, v.z, l.distance, l.decay, 0, 0, 0, 0, 0, 0, 0);
        } else if (type === 'spot' && l.isSpotLight) {
          if (count++ >= MAX_LIGHTS) continue;
          v.setFromMatrixPosition(l.matrixWorld).applyMatrix4(view);
          const px = v.x, py = v.y, pz = v.z;
          // eje hacia la luz (posicion - objetivo) en vista, normalizado
          v.setFromMatrixPosition(l.matrixWorld);
          const t = new Vector3().setFromMatrixPosition(l.target.matrixWorld);
          v.sub(t).transformDirection(view);
          lightData.push(3, l.color.r * k, l.color.g * k, l.color.b * k, px, py, pz, l.distance, l.decay, v.x, v.y, v.z, Math.cos(l.angle), Math.cos(l.angle * (1 - l.penumbra)), (this.layerOf.get(l) ?? -1) + 1, 0);
        } else if (type === 'rect' && l.isRectAreaLight) {
          if (count++ >= MAX_LIGHTS) continue;
          // posicion, medio ancho y medio alto en vista (WebGLLights: rotacion de la matriz de vista x matrixWorld)
          this.m4.copy(l.matrixWorld).premultiply(view);
          this.m42.extractRotation(this.m4);
          v.setFromMatrixPosition(this.m4);
          const hw = new Vector3(l.width * 0.5, 0, 0).applyMatrix4(this.m42), hh = new Vector3(0, l.height * 0.5, 0).applyMatrix4(this.m42);
          lightData.push(4, l.color.r * k, l.color.g * k, l.color.b * k, v.x, v.y, v.z, 0, 0, hw.x, hw.y, hw.z, hh.x, hh.y, hh.z, 0);
        } else if (type === 'directional' && l.isDirectionalLight) {
          if (count++ >= MAX_LIGHTS) continue;
          v.setFromMatrixPosition(l.matrixWorld);
          const t = new Vector3().setFromMatrixPosition(l.target.matrixWorld);
          v.sub(t).transformDirection(view);
          lightData.push(0, l.color.r * k, l.color.g * k, l.color.b * k, 0, 0, 0, 0, 0, v.x, v.y, v.z, 0, 0, (this.layerOf.get(l) ?? -1) + 1, 0);
        }
      }
    }
    lightData.push(...hemi);
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
    g[51] = camera.isOrthographicCamera ? 1 : 0;
    g[50] = Math.min(count, MAX_LIGHTS);
    g[56] = nLayers;
    g[58] = st.linear ? 1 : 0;
    g[48] = st.clearFlags ?? 3;
    g[57] = st.shadow.type === 3 ? 2 : st.shadow.type;

    return {
      globals: g,
      objects: objs.subarray(0, no * OBJECT_F),
      shadows: shadowData,
      shadowPasses: new Uint32Array(shadowPasses),
      shadowAlloc,
      shadowRan: shadowRan || force || fresh.size > 0,
      materials: new Float32Array(matData),
      lights: new Float32Array(lightData),
      draws: new Uint32Array(draws),
      nDraws: mainDraws,
      triangles,
    };
  }

  /** WebGLShadowMap.renderObject: mallas que proyectan sombra dentro del frustum de la camara de sombra. */
  private collectCasters(object: any, camera: any, frustum: Frustum, out: Array<{ object: any; geometry: any; material: any; group: any }>) {
    if (object.visible === false) return;
    if (object.layers.test(camera.layers) && object.isMesh && object.castShadow && (!object.frustumCulled || frustum.intersectsObject(object))) {
      const geo = object.geometry;
      const gp = geo.attributes.position;
      if (gp && gp.count > 0) {
        const push = (material: any, group: any) => {
          if (material && material.visible !== false && material.color) out.push({ object, geometry: geo, material, group });
        };
        if (Array.isArray(object.material)) {
          for (const group of geo.groups) push(object.material[group.materialIndex], group);
        } else push(object.material, null);
      }
    }
    for (const c of object.children) this.collectCasters(c, camera, frustum, out);
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
        if (object.isSkinnedMesh && (!object.skeleton || !object.geometry.attributes.skinIndex)) warnOnce('skin-sin-datos', 'SkinnedMesh sin skeleton o sin skinIndex/skinWeight: se dibuja como Mesh');
        if (!object.frustumCulled || this.frustum.intersectsObject(object)) {
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
          const z = this.v.z;
          const push = (mat: any, group: any) => {
            if (!mat || mat.visible === false) return;
            const item: Item = { object, geometry: geo, material: mat, groupOrder, renderOrder: object.renderOrder, z, id: object.id, group };
            (mat.transparent ? this.transparent : this.opaque).push(item);
          };
          if (Array.isArray(object.material)) {
            for (const group of geo.groups) push(object.material[group.materialIndex], group);
          } else push(object.material, null);
        }
      } else if (object.isPoints || object.isLine || object.isSprite) warnOnce(object.type, `${object.type} aun no esta soportado y se omite`);
    }
    for (const c of object.children) this.project(c, camera, groupOrder);
  }
}
