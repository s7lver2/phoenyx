// Parches de material (`onBeforeCompile`) del juego, portados a ganchos del sombreador estandar (crates/phoenyx-gl/src/shader.wgsl).
// Un parche reescribe chunks GLSL de un MeshStandardMaterial. Para reconocerlo se ejecuta el `onBeforeCompile` del material sobre un
// sombreador de mentira que solo contiene las lineas `#include <chunk>`; el texto resultante (con el GLSL tal cual del juego) da su
// huella. Cada huella conocida lleva el id del gancho del WGSL y el empaquetado de los uniformes que el parche anade a `shader.uniforms`.
// @ts-nocheck

export interface PatchDef {
  /** id del gancho en shader.wgsl (m.pad.x) */
  id: number;
  name: string;
  /** uniformes del parche como hasta 2 vec4 (8 floats), en el orden que lee el WGSL (pe0, pe1) */
  pack(u: any): number[];
  /** trabajo extra por fotograma (p. ej. subir el lightmap): recibe los uniformes y el anfitrion Rust */
  sync?(u: any, gl: any, state: { lmKey: string }): void;
}

const PROBE_V = ['common', 'beginnormal_vertex', 'begin_vertex'].map((c) => `#include <${c}>`).join('\n');
const PROBE_F = ['common', 'map_fragment', 'color_fragment', 'roughnessmap_fragment', 'lights_physical_fragment', 'lights_fragment_begin', 'opaque_fragment'].map((c) => `#include <${c}>`).join('\n');

/** FNV-1a de 32 bits, en hexadecimal. */
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) (h ^= s.charCodeAt(i)), (h = Math.imul(h, 0x01000193));
  return (h >>> 0).toString(16);
};

const known = new Map<string, PatchDef>();
export function registerPatch(hash: string, def: PatchDef) {
  known.set(hash, def);
}

const vec = (v: any) => [v.r ?? v.x ?? 0, v.g ?? v.y ?? 0, v.b ?? v.z ?? 0, v.w ?? 0];

// 1: tinte de cosmeticos (game/cosmetics.ts, cos-tint): pe0 = (uTint.rgb, uTintMix)
registerPatch('bda348e4', { id: 1, name: 'cos-tint', pack: (u) => [u.uTint.value.r, u.uTint.value.g, u.uTint.value.b, u.uTintMix.value, 0, 0, 0, 0] });
// 2: luz horneada (game/lightmap.ts): pe0 = uFlick, pe1 = (uLmSize.xy, uLmGain, _); las texturas uLm y uLm2 se suben al anfitrion
registerPatch('c0923b4a', {
  id: 2,
  name: 'lightmap',
  pack: (u) => [...vec(u.uFlick.value), u.uLmSize.value.x, u.uLmSize.value.y, u.uLmGain.value, 0],
  sync(u, gl, st) {
    const a = u.uLm.value, b = u.uLm2.value;
    if (!a || !b || !a.image?.data || !b.image?.data) return;
    const key = `${a.uuid}:${a.version}:${b.uuid}:${b.version}`;
    if (key === st.lmKey) return;
    st.lmKey = key;
    gl.set_lightmap(a.image.width, a.image.height, a.image.data, b.image.data);
  },
});
// 3: rugosidad minima del hormigon del parking (game/parking.ts)
registerPatch('c731af62', { id: 3, name: 'concrete', pack: () => [0, 0, 0, 0, 0, 0, 0, 0] });
// 4: baldosa de las Poolrooms (game/poolmap.ts, poolTile)
registerPatch('bc1b8b34', { id: 4, name: 'poolTile', pack: () => [0, 0, 0, 0, 0, 0, 0, 0] });

// 5: polvo anclado del parking (game/parking.ts, addDust: PointsMaterial); el valor va en pack()[0] y lo lee points_basic.wgsl
registerPatch('9bd29522', { id: 5, name: 'parking-dust', pack: (u) => [u.uDustTime.value, 0, 0, 0, 0, 0, 0, 0] });

const cache = new WeakMap<object, { def: PatchDef; uniforms: any } | null>();

/** El parche portado de un material estandar (con sus uniformes vivos) o null si no tiene `onBeforeCompile` propio o no se conoce. */
export function patchOf(m: any, renderer: any): { def: PatchDef; uniforms: any } | null {
  if (!(m.isMeshStandardMaterial || m.isPointsMaterial) || !Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) return null;
  let r = cache.get(m);
  if (r !== undefined) return r;
  r = null;
  const sh = { uniforms: {}, vertexShader: PROBE_V, fragmentShader: PROBE_F };
  try {
    m.onBeforeCompile(sh, renderer);
    const hash = fnv(sh.vertexShader + '\u0000' + sh.fragmentShader);
    const def = known.get(hash);
    if (def) r = { def, uniforms: sh.uniforms };
    else console.warn(`[phoenyx] onBeforeCompile sin version WGSL (huella ${hash}): se dibuja sin el parche`);
  } catch (e) {
    console.warn('[phoenyx] onBeforeCompile no se pudo evaluar: se dibuja sin el parche', e);
  }
  cache.set(m, r);
  return r;
}
