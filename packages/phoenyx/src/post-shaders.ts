// Registro de los shaders de pase de three 0.160.1 portados a WGSL (post.wgsl). Cada uno se identifica por su GLSL original.
// @ts-nocheck (usa el JS de three copiado)
import { CopyShader } from './jsm/shaders/CopyShader.js';
import { registerPassShader } from './passes';

// id 0: fs_copy
registerPassShader(CopyShader.fragmentShader, { id: 0, tex: ['tDiffuse'], pack: (m) => [m.uniforms.opacity.value] });
