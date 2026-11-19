// Polvo del juego (client/src/game/game.ts, `dust`): GLSL tal cual asociado a user/dust_cam.wgsl (Points).
// @ts-nocheck
import { registerUserShader } from './index';

export const vertexShader = `
        uniform vec3 uCam;
        uniform float uTime, uBeam, uPx;
        varying float vA;
        void main() {
          // a la deriva, lenta, y siempre en una caja de 8 m centrada en la cámara
          vec3 p = position + vec3(sin(uTime * 0.13 + position.y) * 0.4, -uTime * 0.03, cos(uTime * 0.11 + position.x) * 0.4);
          p = mod(p - uCam + 4.0, 8.0) - 4.0 + uCam;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = length(mv.xyz);
          // el haz: el cono de la linterna (mira al frente desde la cámara), más fuerte cerca
          float beam = smoothstep(0.86, 0.97, dot(normalize(mv.xyz), vec3(0.0, -0.05, -1.0))) * uBeam * (1.0 - smoothstep(1.0, 7.0, d));
          // cada mota con su tamaño y su brillo, y un centelleo lento: unas pocas se ven siempre, flotando en la luz
          float h = fract(sin(dot(position, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          float tw = 0.65 + 0.35 * sin(uTime * (0.6 + h * 1.4) + h * 40.0);
          vA = (0.03 + 0.5 * beam) * (0.45 + h) * tw;
          gl_PointSize = uPx * (0.6 + h * 1.0) / max(d, 1.2); // las de muy cerca, no como pelotas
          gl_Position = projectionMatrix * mv;
        }`;
export const fragmentShader = `
        varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(1.0, 0.93, 0.78) * vA * (1.0 - smoothstep(0.1, 0.5, r)), 1.0);
        }`;

registerUserShader(vertexShader, fragmentShader, {
  id: 7,
  points: true,
  // [uCam.xyz, uTime], [uBeam, uPx, _, _]
  pack: (m) => {
    const u = m.uniforms;
    return [u.uCam.value.x, u.uCam.value.y, u.uCam.value.z, u.uTime.value, u.uBeam.value, u.uPx.value, 0, 0];
  },
});
