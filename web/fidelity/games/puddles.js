// Charcos del parking (client/src/game/parking-puddles.ts): el mismo GLSL, la misma geometria de decals y el mismo Reflector compartido.
export function makePuddles(THREE, Reflector) {
  const shader = {
    uniforms: { tDiffuse: { value: null }, color: { value: null }, textureMatrix: { value: null } },
    vertexShader: `
    uniform mat4 textureMatrix;
    varying vec4 reflectionUv;
    varying vec2 puddleUv;
    varying vec2 seed;
    #include <fog_pars_vertex>
    void main() {
      reflectionUv = textureMatrix * vec4(position, 1.0);
      puddleUv = uv * 2.0 - 1.0;
      seed = position.xy;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `,
    fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec4 reflectionUv;
    varying vec2 puddleUv;
    varying vec2 seed;
    #include <fog_pars_fragment>
    float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
    }
    void main() {
      float angle = atan(puddleUv.y, puddleUv.x + 0.00001);
      float r = length(puddleUv);
      // la silueta base (la misma que usa wetAt) con un borde irregular que cambia de un charco a otro
      float edge = 0.76 + 0.12 * sin(angle * 3.0) + 0.07 * cos(angle * 7.0) + (vnoise(puddleUv * 5.0 + seed * 3.1) - 0.5) * 0.14;
      float body = 1.0 - smoothstep(edge - 0.26, edge, r);          // el agua: opaca en el centro, se funde hacia el borde
      float halo = (1.0 - smoothstep(edge - 0.05, edge + 0.2, r)) * 0.55; // el asfalto mojado alrededor: oscuro y sin reflejo
      float alpha = max(body, halo);
      if (alpha <= 0.01) discard;
      // el reflejo, ondulado un poco y más fuerte hacia el centro (como un decal de agua, no un espejo recortado)
      vec2 wob = (vec2(vnoise(puddleUv * 7.0 + seed), vnoise(puddleUv * 7.0 - seed)) - 0.5) * 0.012;
      vec4 ruv = reflectionUv; ruv.xy += wob * ruv.w;
      vec3 reflected = texture2DProj(tDiffuse, ruv).rgb;
      float k = smoothstep(0.0, 0.9, body);
      float rim = smoothstep(edge - 0.16, edge - 0.02, r) * body; // un filo claro donde el agua toca el suelo
      vec3 wet = vec3(0.006, 0.009, 0.009);
      vec3 col = wet + reflected * (0.25 + 0.55 * k) + rim * vec3(0.035, 0.04, 0.04);
      gl_FragColor = vec4(col, alpha * (0.3 + 0.6 * k) * 0.95);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }
  `,
  };
  const spots = [{ x: -1.2, z: 1.0, width: 2.6, depth: 1.6, angle: 0.4 }, { x: 1.6, z: -1.5, width: 3.2, depth: 1.9, angle: 1.9 }, { x: 0.4, z: -4, width: 2.2, depth: 1.2, angle: 2.7 }];
  const geometry = new THREE.BufferGeometry(), positions = [], uvs = [];
  for (const { x, z, width, depth, angle } of spots) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (const [u, v] of [[0, 1], [0, 0], [1, 1], [0, 0], [1, 0], [1, 1]]) {
      const dx = (u - .5) * width, dz = (v - .5) * depth;
      positions.push(x + dx * cos - dz * sin, -z + dx * sin + dz * cos, 0);
      uvs.push(u, v);
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  const rf = new Reflector(geometry, { textureWidth: 384, textureHeight: 216, multisample: 0, clipBias: .003, shader });
  const material = rf.material;
  material.transparent = true;
  material.depthWrite = false;
  material.fog = true;
  Object.assign(material.uniforms, THREE.UniformsUtils.clone(THREE.UniformsLib.fog));
  rf.rotation.x = -Math.PI / 2;
  rf.renderOrder = 1;
  rf.position.y = 0.004;
  return rf;
}
