// Registro de los shaders de pase de three 0.160.1 portados a WGSL (post.wgsl). Cada uno se identifica por su GLSL original.
// @ts-nocheck (usa el JS de three copiado)
import { CopyShader } from './jsm/shaders/CopyShader.js';
import { OutputShader } from './jsm/shaders/OutputShader.js';
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
