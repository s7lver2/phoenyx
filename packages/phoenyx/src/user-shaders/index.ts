// Registro de shaders de usuario: un `ShaderMaterial` de la escena (GLSL) se reconoce por el texto exacto de su
// `vertexShader` + `fragmentShader` y se dibuja con el WGSL portado a mano en phoenyx-gl (`user/<archivo>.wgsl`, id en `user_src`).
// Cada archivo de esta carpeta copia el GLSL del juego tal cual y registra su empaquetado de uniformes.
// @ts-nocheck (usa el JS de three copiado)

export interface UserShaderDef {
  /** id del WGSL en `user_src` (lib.rs) */
  id: number;
  /** uniformes del material en floats, a partir del vec4 1 (el vec4 0 lo pone el renderer: x = fog); multiplo de 4 */
  pack(m: any): number[];
  /** texturas t0..t4 (hasta 5), en el orden que lee el WGSL */
  textures?(m: any): any[];
  /** el shader dibuja `Points`: un cuadrado por vertice (user/_points.wgsl) */
  points?: boolean;
  /** atributos de la geometria que van a cada hueco del vertice (normal 3, uv 2, color 3 floats): nombres en orden, cada uno aporta sus componentes */
  attributes?: { normal?: string[]; uv?: string[]; color?: string[] };
}

const registry = new Map<string, UserShaderDef>();

/** Asocia el GLSL de un ShaderMaterial del juego con su version WGSL. */
export function registerUserShader(vertexShader: string, fragmentShader: string, def: UserShaderDef) {
  registry.set(vertexShader + '\u0000' + fragmentShader, def);
}

/** Contexto del renderer que necesitan los materiales integrados (tamano de punto en pixeles). */
export interface BuiltinCtx { pixelRatio: number; height: number }

/** PointsMaterial de three (points_vert/points_frag): shader integrado id 20 (user/points_basic.wgsl). */
function pointsDef(ctx: BuiltinCtx): UserShaderDef {
  return {
    id: 20,
    points: true,
    textures: (m) => [m.map],
    pack: (m) => {
      const map = m.map;
      if (map && map.matrixAutoUpdate === true) map.updateMatrix();
      const e = map ? map.matrix.elements : [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const opaque = m.transparent === false && m.blending === 1 && !m.alphaToCoverage;
      return [
        m.size * ctx.pixelRatio, ctx.height * 0.5, m.sizeAttenuation ? 1 : 0, m.toneMapped ? 1 : 0,
        m.color.r, m.color.g, m.color.b, m.opacity,
        e[0], e[1], e[3], e[4],
        e[6], e[7], map && map.image ? 1 : 0, m.alphaTest > 0 ? m.alphaTest : 0,
        m.vertexColors ? 1 : 0, opaque ? 1 : 0, 0, 0,
      ];
    },
  };
}

export function userShaderOf(material: any, ctx?: BuiltinCtx): UserShaderDef | undefined {
  if (material.isPointsMaterial) return ctx ? pointsDef(ctx) : undefined;
  return registry.get(material.vertexShader + '\u0000' + material.fragmentShader);
}

/** Color de three como 3 floats (valores lineales del espacio de trabajo, como los sube WebGLUniforms). */
export const rgb = (c: any) => [c.r, c.g, c.b];
