// Gas de los conductos (client/src/game/vents.ts, gas()): GLSL tal cual (con DUCT_H = 1.60 sustituido) asociado a user/vents_gas.wgsl.
// @ts-nocheck
import { registerUserShader } from './index';

export const vertexShader = `
        attribute float aSeed; uniform float uT; varying float vA; varying float vS; varying float vR;
        void main() {
          float s = aSeed, h = fract(position.y / 1.60 + uT * (0.025 + s * 0.04));
          vec3 p = position;
          p.y = h * 1.60;
          p.x += sin(uT * (0.25 + s * 0.35) + s * 40.0) * 0.4;
          p.z += cos(uT * (0.2 + s * 0.3) + s * 70.0) * 0.4;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = max(-mv.z, 0.4);
          vA = sin(h * 3.14159) * smoothstep(0.35, 1.2, d); vS = s; vR = uT * (0.15 + s * 0.2) * (s > 0.5 ? 1.0 : -1.0) + s * 6.0;
          gl_PointSize = min((0.9 + s * 0.9) * 640.0 / d, 420.0);
          gl_Position = projectionMatrix * mv;
        }`;
export const fragmentShader = `
        uniform sampler2D uMap; varying float vA; varying float vS; varying float vR;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float c = cos(vR), sn = sin(vR);
          vec2 uv = vec2(c * q.x - sn * q.y, sn * q.x + c * q.y) + 0.5;
          float m = texture2D(uMap, uv).a * smoothstep(0.5, 0.2, length(q));
          vec3 col = mix(vec3(0.30, 0.62, 0.12), vec3(0.62, 0.92, 0.28), vS);
          gl_FragColor = vec4(col * (0.8 + 0.5 * m), m * vA * 0.9);
        }`;

registerUserShader(vertexShader, fragmentShader, {
  id: 6,
  points: true,
  // aSeed cabe en el hueco uv del vertice (x = aSeed)
  attributes: { uv: ['aSeed'] },
  textures: (m) => [m.uniforms.uMap.value],
  // [uT, _, _, _]
  pack: (m) => [m.uniforms.uT.value, 0, 0, 0],
});
