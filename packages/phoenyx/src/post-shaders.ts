// Registro de los shaders de pase de three 0.160.1 portados a WGSL (post.wgsl). Cada uno se identifica por su GLSL original.
// @ts-nocheck (usa el JS de three copiado)
import { CopyShader } from './jsm/shaders/CopyShader.js';
import { SMAAEdgesShader, SMAAWeightsShader, SMAABlendShader } from './jsm/shaders/SMAAShader.js';
import { OutputShader } from './jsm/shaders/OutputShader.js';
import { LuminosityHighPassShader } from './jsm/shaders/LuminosityHighPassShader.js';
import { UnrealBloomPass } from './jsm/postprocessing/UnrealBloomPass.js';
import { Vector2 } from 'three';
import { GTAOShader, GTAODepthShader, GTAOBlendShader } from './jsm/shaders/GTAOShader.js';
import { PoissonDenoiseShader } from './jsm/shaders/PoissonDenoiseShader.js';
import { registerPassShader, registerPassShaderByName } from './passes';
import './user-shaders/vhs';

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

// ids 8 a 11: GTAOPass (oclusion ambiental, denoise de Poisson, profundidad lineal y mezcla multiplicativa)
registerPassShader(GTAOShader.fragmentShader, {
  id: 8,
  tex: ['tNormal', 'tNoise'],
  depth: 'tDepth',
  pack: (m) => {
    const u = m.uniforms, d = m.defines ?? {};
    if (d.DEPTH_SWIZZLING === 'w') console.warn('[phoenyx] GTAOPass con la profundidad en el canal w no esta soportado');
    const out = [u.resolution.value.x, u.resolution.value.y, u.cameraNear.value, u.cameraFar.value, u.radius.value, u.distanceExponent.value, u.thickness.value, u.distanceFallOff.value];
    out.push(u.scale.value, d.SAMPLES, d.NORMAL_VECTOR_TYPE, (d.SCREEN_SPACE_RADIUS === 1 ? 1 : 0) | (d.SCENE_CLIP_BOX === 1 ? 2 : 0));
    out.push(d.SCREEN_SPACE_RADIUS_SCALE ?? 100, 0, 0, 0);
    const a = u.sceneBoxMin.value, b = u.sceneBoxMax.value;
    out.push(a.x, a.y, a.z, 0, b.x, b.y, b.z, 0);
    out.push(...u.cameraProjectionMatrix.value.elements, ...u.cameraProjectionMatrixInverse.value.elements, ...u.cameraWorldMatrix.value.elements);
    return out;
  },
});
registerPassShader(PoissonDenoiseShader.fragmentShader, {
  id: 9,
  tex: ['tDiffuse', 'tNormal', 'tNoise'],
  depth: 'tDepth',
  pack: (m) => {
    const u = m.uniforms, d = m.defines ?? {};
    if (d.DEPTH_VALUE_SOURCE === 1) console.warn('[phoenyx] PoissonDenoiseShader con la profundidad en alfa no esta soportado');
    const out = [u.resolution.value.x, u.resolution.value.y, u.lumaPhi.value, u.depthPhi.value, u.normalPhi.value, u.radius.value, u.index.value, d.SAMPLES, d.NORMAL_VECTOR_TYPE, 0, 0, 0];
    out.push(...u.cameraProjectionMatrixInverse.value.elements);
    // los puntos del disco llegan como texto GLSL (vec3[SAMPLES](vec3(x, y, r),...))
    for (const s of String(d.SAMPLE_VECTORS).matchAll(/vec3\(([^,]+),([^,]+),([^)]+)\)/g)) out.push(parseFloat(s[1]), parseFloat(s[2]), parseFloat(s[3]), 0);
    return out;
  },
});
registerPassShader(GTAODepthShader.fragmentShader, {
  id: 11,
  tex: [],
  depth: 'tDepth',
  pack: (m) => [m.uniforms.cameraNear.value, m.uniforms.cameraFar.value, m.defines.PERSPECTIVE_CAMERA === 1 ? 1 : 0, 0],
});
registerPassShader(GTAOBlendShader.fragmentShader, { id: 10, tex: ['tDiffuse'], pack: (m) => [m.uniforms.intensity.value] });

// ids 5 a 7: SMAAPass (bordes, pesos y mezcla); la resolucion es 1/ancho, 1/alto
registerPassShader(SMAAEdgesShader.fragmentShader, {
  id: 5,
  tex: ['tDiffuse'],
  pack: (m) => [m.uniforms.resolution.value.x, m.uniforms.resolution.value.y, parseFloat(m.defines.SMAA_THRESHOLD), 0],
});
registerPassShader(SMAAWeightsShader.fragmentShader, {
  id: 6,
  tex: ['tDiffuse', 'tArea', 'tSearch'],
  pack: (m) => [m.uniforms.resolution.value.x, m.uniforms.resolution.value.y, 0, 0],
});
registerPassShader(SMAABlendShader.fragmentShader, {
  id: 7,
  tex: ['tDiffuse', 'tColor'],
  pack: (m) => [m.uniforms.resolution.value.x, m.uniforms.resolution.value.y, 0, 0],
});

// id 14: PMREMGenerator (SphericalGaussianBlur): desenfoque de la textura CubeUV nivel a nivel. El material lo crea three en tiempo de ejecucion.
// u[0] = (samples, latitudinal, dTheta, mipInt), u[1] = (poleAxis.xyz, tamano de la cara de salida), u[2..6] = weights[20]
registerPassShaderByName('SphericalGaussianBlur', {
  id: 14,
  tex: ['envMap'],
  pack: (m, ctx) => {
    const u = m.uniforms, p = u.poleAxis.value, w = u.weights.value;
    // el viewport del destino cubre 3 x 2 caras de `S` pixeles
    const S = ctx && ctx.viewport[2] ? ctx.viewport[2] / 3 : 0;
    const out = [u.samples.value, u.latitudinal.value ? 1 : 0, u.dTheta.value, u.mipInt.value, p.x, p.y, p.z, S];
    for (let i = 0; i < 20; i++) out.push(w[i] ?? 0);
    return out;
  },
});
