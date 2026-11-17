// Registro de los shaders de pase de three 0.160.1 portados a WGSL (post.wgsl). Cada uno se identifica por su GLSL original.
// @ts-nocheck (usa el JS de three copiado)
import { CopyShader } from './jsm/shaders/CopyShader.js';
import { OutputShader } from './jsm/shaders/OutputShader.js';
import { LuminosityHighPassShader } from './jsm/shaders/LuminosityHighPassShader.js';
import { UnrealBloomPass } from './jsm/postprocessing/UnrealBloomPass.js';
import { Vector2 } from 'three';
import { registerPassShader } from './passes';

// id 0: fs_copy
registerPassShader(CopyShader.fragmentShader, { id: 0, tex: ['tDiffuse'], pack: (m) => [m.uniforms.opacity.value] });

// id 1: fs_output (tone mapping y codificacion sRGB; los modos salen de los defines que fija OutputPass)
const TM = ['LINEAR_TONE_MAPPING', 'REINHARD_TONE_MAPPING', 'CINEON_TONE_MAPPING', 'ACES_FILMIC_TONE_MAPPING'];
registerPassShader(OutputShader.fragmentShader, {
  id: 1,
  tex: ['tDiffuse'],
  pack: (m) => {
    const d = m.defines ?? {};
    if ('AGX_TONE_MAPPING' in d) console.warn('[phoenyx] AgXToneMapping no esta soportado');
    return [m.uniforms.toneMappingExposure.value, TM.findIndex((k) => k in d) + 1, 'SRGB_TRANSFER' in d ? 1 : 0, 0];
  },
});

// ids 2 a 4: UnrealBloomPass (alto contraste de luminancia, blur gaussiano separable y composicion de los mips)
registerPassShader(LuminosityHighPassShader.fragmentShader, {
  id: 2,
  tex: ['tDiffuse'],
  pack: (m) => {
    const u = m.uniforms;
    return [u.luminosityThreshold.value, u.smoothWidth.value, u.defaultOpacity.value, 0, u.defaultColor.value.r, u.defaultColor.value.g, u.defaultColor.value.b, 0];
  },
});
// los GLSL de blur y composicion los construye la propia clase: se obtienen de una instancia desechable
const bloom = new UnrealBloomPass(new Vector2(2, 2), 1, 0, 0);
registerPassShader(bloom.separableBlurMaterials[0].fragmentShader, {
  id: 3,
  tex: ['colorTexture'],
  pack: (m) => {
    const u = m.uniforms;
    const c = u.gaussianCoefficients.value;
    const out = [u.invSize.value.x, u.invSize.value.y, u.direction.value.x, u.direction.value.y, m.defines.KERNEL_RADIUS, 0, 0, 0];
    for (let i = 0; i < 12; i++) out.push(c[i] ?? 0);
    return out;
  },
});
registerPassShader(bloom.compositeMaterial.fragmentShader, {
  id: 4,
  tex: ['blurTexture1', 'blurTexture2', 'blurTexture3', 'blurTexture4', 'blurTexture5'],
  pack: (m) => {
    const u = m.uniforms;
    const f = u.bloomFactors.value, t = u.bloomTintColors.value;
    const out = [u.bloomStrength.value, u.bloomRadius.value, 0, 0, f[0], f[1], f[2], f[3], f[4], 0, 0, 0];
    for (let i = 0; i < 5; i++) out.push(t[i].x, t[i].y, t[i].z, 0);
    return out;
  },
});
bloom.dispose();
