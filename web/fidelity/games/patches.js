import * as THREE from 'three';
// Parches de material de client/src/game (cosmetics.ts, lightmap.ts, parking.ts, poolmap.ts): el cuerpo de cada `onBeforeCompile`, tal cual,
// aplicado a materiales de la sala de pruebas.
export const LM = {
  uLm: { value: null },
  uLm2: { value: null },
  uFlick: { value: new THREE.Vector4(1, 1, 1, 1) },
  uLmSize: { value: new THREE.Vector2(1, 1) },
  uLmGain: { value: 1 },
};
const lmPatch = function (s) {
  Object.assign(s.uniforms, LM);
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vLmP;\nvarying vec3 vLmN;')
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec4 lmW = vec4(transformed, 1.0);
      vec3 lmN = objectNormal;
      #ifdef USE_INSTANCING
        lmW = instanceMatrix * lmW;
        lmN = mat3(instanceMatrix) * lmN;
      #endif
      vLmP = (modelMatrix * lmW).xyz;
      vLmN = normalize(mat3(modelMatrix) * lmN);`,
    );
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform sampler2D uLm;\nuniform sampler2D uLm2;\nuniform vec4 uFlick;\nuniform vec2 uLmSize;\nuniform float uLmGain;\nvarying vec3 vLmP;\nvarying vec3 vLmN;')
    .replace(
      '#include <opaque_fragment>',
      `{
        vec3 n = normalize(vLmN);
        vec2 lmUv = (vLmP.xz + n.xz * 0.45) / uLmSize;
        vec4 lm = texture2D(uLm, lmUv);
        // los tubos que parpadean (cada grupo con su nivel) se suman a la luz fija, del mismo color de tubo viejo
        lm.rgb += vec3(1.0, 0.93, 0.74) * dot(texture2D(uLm2, lmUv), uFlick);
        // en las paredes: el rodapié en sombra y una franja más oscura bajo el techo
        float side = 1.0 - abs(n.y);
        float grad = mix(1.0, 0.5 + 0.5 * smoothstep(-0.1, 0.8, vLmP.y), side) * mix(1.0, 0.82, side * smoothstep(2.1, 2.7, vLmP.y));
        // el techo recibe poco de unos paneles que alumbran hacia abajo
        float up = n.y < -0.5 ? 0.42 : 1.0;
        outgoingLight = outgoingLight * lm.a * grad + diffuseColor.rgb * lm.rgb * 1.5 * lm.a * grad * up * uLmGain;
      }
      #include <opaque_fragment>`,
    );
};
export function lightmapped(m) {
  m.onBeforeCompile = lmPatch;
}
/** Un lightmap sintetico de `w` x `h` texels (RGBA8): luz que varia por la planta, oclusion en los bordes y un canal de tubo que parpadea. */
export function makeLightmap(THREE, w, h, size) {
  const d0 = new Uint8Array(w * h * 4), d1 = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 4, u = i / w, v = j / h;
      const l = 0.35 + 0.65 * Math.max(0, Math.sin(u * 12.0) * Math.cos(v * 9.0));
      d0[k] = 255 * l * 1.0; d0[k + 1] = 255 * l * 0.93; d0[k + 2] = 255 * l * 0.74;
      d0[k + 3] = 255 * Math.min(1, 0.45 + 2.2 * Math.min(u, 1 - u, v, 1 - v));
      d1[k] = 255 * Math.max(0, Math.sin(u * 7.0 + 1.0)); d1[k + 1] = 255 * Math.max(0, Math.cos(v * 6.0)); d1[k + 2] = 0; d1[k + 3] = 0;
    }
  const mk = (d) => { const t = new THREE.DataTexture(d, w, h); t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t; };
  LM.uLm.value = mk(d0);
  LM.uLm2.value = mk(d1);
  LM.uLmSize.value.set(size, size);
  LM.uFlick.value.set(0.8, 0.3, 0, 0);
  LM.uLmGain.value = 0.9;
}
export function cosTint(THREE, material, tint, tintMix) {
  const c = material;
  c.onBeforeCompile = (s) => {
            s.uniforms.uTint = tint;
            s.uniforms.uTintMix = tintMix;
            s.fragmentShader = s.fragmentShader
              .replace('#include <common>', '#include <common>\nuniform vec3 uTint;\nuniform float uTintMix;')
              .replace('#include <map_fragment>', '#include <map_fragment>\n{ float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)); diffuseColor.rgb = mix(diffuseColor.rgb, uTint * l * 1.3, uTintMix); }');
  };
  c.customProgramCacheKey = () => 'cos-tint';
  return c;
}
export function poolTile(THREE, tile) {
  tile.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying float vUp;').replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvUp = normalize(mat3(modelMatrix) * objectNormal).y;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying float vUp;\nfloat h31(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }\nfloat vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y), mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }')
        // el sol solo calienta lo que mira hacia arriba (suelos): en las caras verticales se colaba por las esquinas de las paredes de grosor cero
        .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= smoothstep(0.5, 0.8, vUp);'))
        .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        { float fl = smoothstep(0.6, 0.9, vUp); material.clearcoat *= fl; material.roughness = mix(max(material.roughness, 0.6), material.roughness, fl); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        { float t = h31(floor(vWp / 0.12 + 0.01)), b = vn(vWp * 0.35), s = vn(vWp * 1.7 + 9.0);
          diffuseColor.rgb *= (0.93 + 0.1 * t) * (0.86 + 0.28 * b) * vec3(1.0 + 0.05 * (b - 0.5), 1.0, 1.0 - 0.06 * (b - 0.5));
          diffuseColor.rgb *= 1.0 - 0.28 * smoothstep(0.55, 0.9, s) * (0.4 + 0.6 * smoothstep(1.2, -0.2, vWp.y)); }`);
  };
  tile.customProgramCacheKey = () => 'poolTile';
  return tile;
}
export function concrete(m) {
  m.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = max(roughnessFactor,.85);'); };
  return m;
}
