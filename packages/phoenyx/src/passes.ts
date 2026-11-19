// Registro de shaders de pase (postproceso): un `ShaderMaterial` de three (GLSL) se reconoce por el texto exacto de su
// `fragmentShader` y se ejecuta con el WGSL portado de phoenyx-gl (`post.wgsl`). Un shader desconocido avisa y copia la entrada.
// @ts-nocheck (usa el JS de three copiado)

export interface PassShaderDef {
  /** indice del fragment en `Gl::pass` (post.wgsl) */
  id: number;
  /** nombres de uniformes de textura que ocupan las 4 texturas filtrables, en orden */
  tex: string[];
  /** uniforme de textura que se lee sin filtrar (profundidad), si lo hay */
  depth?: string;
  /** empaqueta los uniformes del material en floats (cada shader define su orden en post.wgsl) */
  /** `ctx.viewport` = viewport del destino actual (x, y, ancho, alto) */
  pack(m: any, ctx?: { viewport: number[] }): number[];
}

const registry = new Map<string, PassShaderDef>();

/** Asocia el GLSL de un shader de three con su version WGSL. */
export function registerPassShader(fragmentShader: string, def: PassShaderDef) {
  registry.set(fragmentShader, def);
}

const byName = new Map<string, PassShaderDef>();
/** Asocia un ShaderMaterial por su `name` (los shaders que genera three en tiempo de ejecucion, como el desenfoque de PMREMGenerator). */
export function registerPassShaderByName(name: string, def: PassShaderDef) {
  byName.set(name, def);
}

export function passShaderOf(material: any): PassShaderDef | undefined {
  return registry.get(material.fragmentShader) ?? (material.name ? byName.get(material.name) : undefined);
}

const NormalBlending = 1, AdditiveBlending = 2, CustomBlending = 5;
const Zero = 200, One = 201, SrcAlpha = 204, OneMinusSrcAlpha = 205, Add = 100;

/** Mezcla de un material como la deja WebGLState.setBlending (sin premultipliedAlpha): [modo, srcRGB, dstRGB, ecuacion, srcA, dstA, ecuacionA]. */
export function blendOf(m: any): number[] {
  const b = m.blending === NormalBlending && !m.transparent ? 0 : m.blending;
  if (b === 0 || b === undefined) return [0, One, Zero, Add, One, Zero, Add];
  if (b === NormalBlending) return [1, SrcAlpha, OneMinusSrcAlpha, Add, One, OneMinusSrcAlpha, Add];
  if (b === AdditiveBlending) return [1, SrcAlpha, One, Add, SrcAlpha, One, Add];
  if (b === CustomBlending) return [1, m.blendSrc, m.blendDst, m.blendEquation, m.blendSrcAlpha ?? m.blendSrc, m.blendDstAlpha ?? m.blendDst, m.blendEquationAlpha ?? m.blendEquation];
  return [0, One, Zero, Add, One, Zero, Add];
}
