// Reflejo suave bajo la alfombra de la Suites (client/src/game/world.ts, shader `SuitesFloor` del Reflector): GLSL tal cual asociado a user/world_carpet.wgsl.
// Uniformes (desde el vec4 1): textureMatrix (4 vec4, columnas). textura: t0 = tDiffuse (el reflejo del Reflector).
// @ts-nocheck
import { registerUserShader } from './index';

export const vertexShader = `uniform mat4 textureMatrix; varying vec4 vUv; void main() { vUv = textureMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
export const fragmentShader = `uniform sampler2D tDiffuse; varying vec4 vUv; void main() { vec4 b = texture2DProj(tDiffuse, vUv); gl_FragColor = vec4(b.rgb, 0.22);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;

registerUserShader(vertexShader, fragmentShader, {
  id: 32,
  textures: (m) => [m.uniforms.tDiffuse.value],
  pack: (m) => [...m.uniforms.textureMatrix.value.elements],
});
