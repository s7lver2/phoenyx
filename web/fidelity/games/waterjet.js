// Material de WaterJet (copia de client/src/game/waterjet.ts: mismo GLSL y mismos parametros) y su geometria con una semilla fija.
export function makeJet(THREE) {
  const N = 288;
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pos = new Float32Array(N * 3), life = new Float32Array(N), size = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // un chorro que sale de la mano hacia el fondo, con gotas repartidas a lo largo
    const t = rnd();
    pos[i * 3] = -1 + t * 2.2 + (rnd() - 0.5) * 0.25;
    pos[i * 3 + 1] = 1.1 - t * t * 0.9 + (rnd() - 0.5) * 0.12;
    pos[i * 3 + 2] = 4 - t * 7;
    life[i] = i % 11 === 0 ? 0 : rnd();
    size[i] = 0.9 + rnd() * 1.0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { uScale: { value: 400 } },
    vertexShader: 'attribute float aLife; attribute float aSize; varying float vA; uniform float uScale; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vA = aLife; gl_PointSize = clamp(aSize * uScale * 0.1 / max(-mv.z, 0.3) * (0.55 + 0.6 * aLife), 1.0, 40.0); }',
    fragmentShader: 'varying float vA; void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p); if (d > 1.0) discard; float a = smoothstep(1.0, 0.15, d) * min(1.0, vA * 3.0) * 0.8; gl_FragColor = vec4(mix(vec3(0.5, 0.78, 1.0), vec3(1.0), smoothstep(0.6, 0.0, d) * 0.8), a); }',
  });
  mat.uniforms.uScale.value = 720 / 2; // innerHeight / 2 del juego a 1280x720
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;
  return points;
}
