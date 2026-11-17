// WaterJet del juego (client/src/game/waterjet.ts): GLSL copiado tal cual y asociado a user/waterjet.wgsl (shader de Points).
// @ts-nocheck
import { registerUserShader } from './index';

export const vertexShader = 'attribute float aLife; attribute float aSize; varying float vA; uniform float uScale; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vA = aLife; gl_PointSize = clamp(aSize * uScale * 0.1 / max(-mv.z, 0.3) * (0.55 + 0.6 * aLife), 1.0, 40.0); }';
export const fragmentShader = 'varying float vA; void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p); if (d > 1.0) discard; float a = smoothstep(1.0, 0.15, d) * min(1.0, vA * 3.0) * 0.8; gl_FragColor = vec4(mix(vec3(0.5, 0.78, 1.0), vec3(1.0), smoothstep(0.6, 0.0, d) * 0.8), a); }';

registerUserShader(vertexShader, fragmentShader, {
  id: 1,
  points: true,
  // aLife y aSize caben en el hueco uv del vertice (x = aLife, y = aSize)
  attributes: { uv: ['aLife', 'aSize'] },
  pack: (m) => [m.uniforms.uScale.value, 0, 0, 0],
});
