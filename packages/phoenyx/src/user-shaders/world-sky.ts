// Cielo de la cupula (client/src/game/world.ts, `sky`): GLSL tal cual asociado a user/world_sky.wgsl.
// @ts-nocheck
import { registerUserShader } from './index';

export const vertexShader = 'varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
export const fragmentShader = `
          varying vec3 vD; uniform float uT;
          float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
          void main() {
            vec3 d = normalize(vD); float el = clamp(d.y, 0.0, 1.0);
            vec3 col = mix(vec3(0.72, 0.88, 1.0), vec3(0.16, 0.46, 0.92), pow(el, 0.6)); // azul de postal: demasiado limpio para ser verdad
            vec2 p = d.xz / (d.y + 0.25) * 1.6 + vec2(uT * 0.004, 0.0); // nubes planas de dibujo, casi quietas
            float c = smoothstep(0.55, 0.62, n(p * 1.3) * 0.65 + n(p * 3.1) * 0.35);
            col = mix(col, vec3(1.0), c * 0.9 * smoothstep(0.05, 0.3, el));
            col = floor(col * 9.0 + 0.5) / 9.0; // posterizado: se ven las bandas
            gl_FragColor = vec4(col, 1.0);
          }`;

// [uT, _, _, _]
registerUserShader(vertexShader, fragmentShader, { id: 10, pack: (m) => [m.uniforms.uT.value, 0, 0, 0] });
