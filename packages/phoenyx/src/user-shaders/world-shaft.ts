// Haz de luz de los paneles (client/src/game/world.ts, `shaftMat`): GLSL tal cual asociado a user/world_shaft.wgsl (malla instanciada).
// @ts-nocheck
import { registerUserShader } from './index';

export const vertexShader = `
        attribute vec3 color;
        varying vec3 vC;
        varying float vF;
        void main() {
          mat4 mm = modelViewMatrix;
          #ifdef USE_INSTANCING
            mm = modelViewMatrix * instanceMatrix;
          #endif
          vec4 mv = mm * vec4(position, 1.0);
          vec3 n = normalize(mat3(mm) * normal);
          vF = pow(abs(dot(n, normalize(-mv.xyz))), 2.2);
          vC = color;
          gl_Position = projectionMatrix * mv;
        }`;
export const fragmentShader = `
        varying vec3 vC;
        varying float vF;
        void main() { gl_FragColor = vec4(vC * vF * 0.13, 1.0); }`;

registerUserShader(vertexShader, fragmentShader, { id: 9, pack: () => [0, 0, 0, 0] });
