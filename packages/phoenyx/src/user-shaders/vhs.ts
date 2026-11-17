// FilmShader y VhsShader del juego (client/src/game/vhsPass.ts): GLSL copiado tal cual y asociado a su WGSL (post.wgsl, ids 12 y 13).
// @ts-nocheck
import { registerPassShader } from '../passes';

export const FILM_FRAG = /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uMove, uMad, uVhs, uWarm;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      float mad = uMad * uMad;
      vec2 uv = vUv + mad * uMove * 0.006 * vec2(sin(vUv.y * 9.0 + uTime * 1.7), cos(vUv.x * 7.0 + uTime * 1.3));
      vec2 c = uv - 0.5;
      float r = dot(c, c);
      vec2 off = c * r * (0.007 + 0.06 * mad);
      vec2 sh = vec2(uVhs * 1.6 / uRes.x, 0.0);
      vec3 col = vec3(texture2D(tDiffuse, uv + off + sh).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off - sh).b);
      float l = dot(col, vec3(0.3, 0.59, 0.11));
      col = mix(col, vec3(l), mad * 0.6);
      float g = hash(floor(vUv * uRes) + floor(uTime * 24.0) * uMove * 13.7) - 0.5;
      col += g * (0.07 + 0.08 * mad + 0.05 * uVhs) * (1.0 - 0.5 * l);
      col *= 1.0 - r * (1.15 + 1.6 * mad + 0.6 * uWarm);
      // el hotel: tonos cálidos en las sombras y los medios, un velo naranja en lo que más luce (halación) y algo de contraste
      float lw = dot(col, vec3(0.3, 0.59, 0.11));
      col = mix(col, col * vec3(1.07, 0.97, 0.83), uWarm);
      col += uWarm * vec3(0.05, 0.02, 0.0) * smoothstep(0.5, 1.0, lw);
      col = mix(col, smoothstep(0.0, 1.0, col) * 1.04, uWarm * 0.45);
      gl_FragColor = vec4(col, 1.0);
    }`;
export const VHS_FRAG = /* glsl */ `
    uniform sampler2D tDiffuse, tPrev;
    uniform float uTime, uMove, uLow, uCorrupt, uFlash, uBlack, uAspect, uAmount, uPool;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      // la curva del tubo, leve
      if (uLow < 0.5) { vec2 c = uv - 0.5; uv = 0.5 + c * (1.0 + 0.05 * dot(c, c)); }
      float t = floor(uTime * 30.0) * uMove, row = floor(uv.y * uRes.y / 2.0);
      // la banda de tracking sube despacio y a ratos desaparece; dentro, las filas tiemblan
      float bandOn = step(0.25, fract(uTime * 0.07)) * uMove;
      float bandY = fract(uTime * 0.11);
      float band = (1.0 - smoothstep(0.0, 0.08, abs(uv.y - bandY))) * bandOn;
      uv.x += band * (hash(vec2(row, t)) - 0.5) * 0.035;
      // la imagen nunca está quieta del todo: cada fila tiembla un poco
      uv.x += (hash(vec2(row, t + 7.0)) - 0.5) * 0.003 * uMove;
      // el cambio de cabezal: la franja de abajo se tuerce y se llena de ruido
      float head = (1.0 - smoothstep(0.0, 0.07, uv.y));
      uv.x += head * (0.04 + 0.03 * hash(vec2(row, t))) * (0.5 + 0.5 * uMove);
      // al corromperse: filas que se desplazan a saltos y bloques que se descolocan
      float k = uCorrupt * uCorrupt;
      float tick = floor(uTime * (6.0 + 18.0 * uCorrupt));
      uv.x += k * (hash(vec2(floor(uv.y * 40.0), tick)) - 0.5) * 0.25 * step(0.5, hash(vec2(floor(uv.y * 12.0), tick + 3.0)));
      vec2 blk = floor(uv * vec2(16.0, 9.0));
      uv += k * (vec2(hash(blk + tick), hash(blk - tick)) - 0.5) * 0.08 * step(0.85, hash(blk + tick * 1.3));
      // la cinta es blanda: el brillo emborronado en horizontal (pocas líneas de definición), el color aún
      // más y corrido a la derecha, y lo claro se derrama alrededor
      vec3 col;
      if (uLow > 0.5) col = texture2D(tDiffuse, uv).rgb;
      else {
        float o = 1.0 / uRes.x;
        vec3 soft = vec3(0.0), chroma = vec3(0.0);
        for (int i = -3; i <= 3; i++) soft += texture2D(tDiffuse, uv + vec2(float(i) * o * 2.5, 0.0)).rgb;
        for (int i = -4; i <= 4; i++) chroma += texture2D(tDiffuse, uv + vec2((float(i) * 4.0 - 6.0) * o, 0.0)).rgb;
        soft /= 7.0;
        chroma /= 9.0;
        col = mix(texture2D(tDiffuse, uv).rgb, soft, 0.75);
        float l = dot(col, vec3(0.3, 0.59, 0.11));
        col = vec3(l) + (chroma - dot(chroma, vec3(0.3, 0.59, 0.11))) * (0.95 + 0.5 * uPool);
        col += max(soft - 0.55, 0.0) * 0.7;
      }
      // trozos congelados de un fotograma viejo
      col = mix(col, texture2D(tPrev, uv).rgb, step(0.8, hash(blk * 1.7 + floor(tick / 3.0))) * k);
      // blancos quemados y negros levantados, color algo lavado
      float l = dot(col, vec3(0.3, 0.59, 0.11));
      col = mix(vec3(l), col, 0.72);
      col = col + smoothstep(0.75, 1.0, l) * 0.12;
      col = col * 0.9 + mix(vec3(0.05, 0.05, 0.02), vec3(0.03, 0.04, 0.05), uPool);
      col *= mix(vec3(1.0, 1.03, 0.84), vec3(0.97, 1.0, 1.03), uPool); // el amarillo verdoso de la cinta vieja (en la piscina, neutro y algo frío)
      // estática: siempre un poco; corrupta, casi solo nieve
      float g = hash(floor(vUv * uRes / 1.5) + t * 1.31);
      col += (g - 0.5) * (0.11 + band * 0.3 + head * 0.5);
      // pérdidas de la cinta: alguna raya blanca suelta
      col += step(0.9985, hash(vec2(row, t * 0.7))) * step(0.6, hash(vec2(floor(vUv.x * 7.0), t + row))) * 0.45 * uMove;
      col = mix(col, vec3(g), smoothstep(0.55, 1.0, uCorrupt) * 0.9);
      // líneas de barrido, la banda más clara y el viñeteado
      col *= 0.94 + 0.06 * (1.0 - uPool) * sin(vUv.y * uRes.y * 1.5); // las líneas del barrido (en las Poolrooms, ninguna)
      col += band * 0.06;
      vec2 v = vUv - 0.5;
      col *= 1.0 - dot(v, v) * 0.9;
      // fuera de la curva, negro
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
      if (abs(vUv.x - 0.5) > 0.5 * min(1.0, (4.0 / 3.0) / uAspect)) col = vec3(0.0);
      col = mix(texture2D(tDiffuse, vUv).rgb, col, max(uAmount, max(uCorrupt, uBlack)));
      col = mix(col, vec3(1.0), uFlash);
      col *= 1.0 - uBlack;
      gl_FragColor = vec4(col, 1.0);
    }`;

// id 12: fs_film. u[0] = (uTime, uMove, uMad, uVhs); u[1] = (uWarm, uRes.x, uRes.y, 0)
registerPassShader(FILM_FRAG, {
  id: 12,
  tex: ['tDiffuse'],
  pack: (m) => {
    const u = m.uniforms;
    return [u.uTime.value, u.uMove.value, u.uMad.value, u.uVhs.value, u.uWarm.value, u.uRes.value.x, u.uRes.value.y, 0];
  },
});
// id 13: fs_vhs. u[0] = (uTime, uMove, uLow, uCorrupt); u[1] = (uFlash, uBlack, uAspect, uAmount); u[2] = (uPool, uRes.x, uRes.y, 0)
registerPassShader(VHS_FRAG, {
  id: 13,
  tex: ['tDiffuse', 'tPrev'],
  pack: (m) => {
    const u = m.uniforms;
    return [u.uTime.value, u.uMove.value, u.uLow.value, u.uCorrupt.value, u.uFlash.value, u.uBlack.value, u.uAspect.value, u.uAmount.value, u.uPool.value, u.uRes.value.x, u.uRes.value.y, 0];
  },
});
