// Phoenix · envoltorio JS: deteccion de soporte, carga de paquetes de modelos, creacion del motor,
// ayudantes de luces y vigilancia de errores/perdida de GPU. El resto de la API (set_instances,
// set_lights, set_sun, frame...) es la del objeto que devuelve `createEngine`.
import init, { create } from "./pkg/phoenix.js";

/** `true` si el navegador tiene WebGPU con `indirect-first-instance` (necesario para los draws por GPU). */
export async function supported() {
  try {
    const a = navigator.gpu && (await navigator.gpu.requestAdapter());
    return !!a && a.features.has("indirect-first-instance");
  } catch {
    return false;
  }
}

const get = async (u, json) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u}: ${r.status}`);
  return json ? r.json() : new Uint8Array(await r.arrayBuffer());
};

/** Descarga un paquete producido por phoenix-bake (meta.json + .bin). */
export async function loadPackage(dir) {
  const meta = await get(dir + "/meta.json", true);
  const none = new Uint8Array(0);
  const [verts, idx, tb, tn, to, gb, gn] = await Promise.all([
    get(dir + "/verts.bin"), get(dir + "/idx.bin"),
    meta.tex ? get(dir + "/tex_base.bin") : none, meta.tex ? get(dir + "/tex_normal.bin") : none,
    meta.tex ? get(dir + "/tex_orm.bin") : none,
    meta.ground ? get(dir + "/ground_base.bin") : none, meta.ground ? get(dir + "/ground_normal.bin") : none,
  ]);
  return { meta, verts, idx, tb, tn, to, gb, gn };
}

/**
 * Crea el motor. `instances`: Float32Array de 8 floats por instancia [x, y, z, escala, modelo, yaw, hash, 0];
 * `capacity`: maximo de instancias (se pueden anadir despues con `set_instances` / `set_count`);
 * `environment`: true = cielo, suelo y sombras del sol.
 */
export async function createEngine(canvas, pkg, { capacity, instances, environment = true }) {
  await init();
  const { meta } = pkg;
  const tex = meta.tex || { size: 0, mips: 0, layers: 0 };
  const gr = meta.ground || { size: 0, mips: 0 };
  return create(canvas, pkg.verts, pkg.idx, new Float32Array(meta.info), new Uint32Array(meta.draws.flat()),
    meta.models, meta.lods, capacity, environment, tex.size, tex.mips, tex.layers, pkg.tb, pkg.tn, pkg.to,
    gr.size, gr.mips, pkg.gb, pkg.gn, instances);
}

/** Luces para `set_lights` (16 floats por luz). Cada ayudante devuelve un array; concatenalos. */
export const light = {
  point: (x, y, z, radius, r, g, b, intensity) => [x, y, z, radius, r, g, b, intensity, 0, 0, 0, 0, 0, 0, 0, 0],
  spot: (x, y, z, radius, r, g, b, intensity, dx, dy, dz, coneDeg) =>
    [x, y, z, radius, r, g, b, intensity, 1, dx, dy, dz, coneDeg, 0, 0, 0],
  tube: (x, y, z, radius, r, g, b, intensity, dx, dy, dz, length) =>
    [x, y, z, radius, r, g, b, intensity, 2, dx, dy, dz, 0, length, 0, 0],
};

/**
 * Vigila el motor: llama a `onProblem(mensaje, perdido)` ante errores de GPU o perdida del dispositivo.
 * Devuelve una funcion `tick()` para llamar una vez por frame (es barata).
 */
export function watch(engine, onProblem) {
  let n = 0, reported = false;
  return () => {
    if (++n % 30) return;
    if (engine.is_lost()) {
      if (!reported) { reported = true; onProblem("Se perdio la GPU. Recarga la pagina.", true); }
      return;
    }
    const e = engine.take_error();
    if (e) onProblem(e, false);
  };
}

/** Carga un personaje con huesos horneado con `phoenix-bake --kind skin`. */
export async function loadSkin(dir) {
  const meta = await get(dir + "/skin.json", true);
  const [verts, idx, mats, tex] = await Promise.all([
    get(dir + "/skin_verts.bin"), get(dir + "/skin_idx.bin"), get(dir + "/skin_mats.bin"), get(dir + "/skin_tex.bin"),
  ]);
  return { meta, verts, idx, mats, tex };
}

/** Anade el personaje al motor y devuelve su indice (para `set_skin_instances`). Instancias: 8 floats [x, y, z, escala, yaw, clip, tiempo, 0]. */
export function addSkin(engine, skin) {
  const m = skin.meta;
  const clips = new Float32Array(m.clips.flatMap((c) => [c.first, c.frames, c.fps, c.dur]));
  return engine.add_skin(skin.verts, skin.idx, skin.mats, clips, m.bones, m.tex_size, m.tex_mips, skin.tex);
}
