// Haz de los paneles y cielo de la cupula de client/src/game/world.ts (mismo GLSL y misma geometria).
export function makeWorldShafts(THREE) {
  const HEIGHT = 2.9;
  const g = new THREE.CylinderGeometry(0.42, 0.85, HEIGHT - 0.2, 12, 1, true);
  const sp = g.attributes.position, sc = new Float32Array(sp.count * 3);
  for (let i = 0; i < sp.count; i++) {
    const k = THREE.MathUtils.clamp(sp.getY(i) / (HEIGHT - 0.2) + 0.5, 0, 1) ** 1.6;
    sc.set([0.5 * k, 0.42 * k, 0.26 * k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: `
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
        }`,
    fragmentShader: `
        varying vec3 vC;
        varying float vF;
        void main() { gl_FragColor = vec4(vC * vF * 0.13, 1.0); }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const spots = [[-3, 0, 2], [0, 0, 0], [3, 0, -2], [-1.5, 0, -4], [2, 0, 3]];
  const mesh = new THREE.InstancedMesh(g, mat, spots.length);
  const mm = new THREE.Matrix4();
  spots.forEach((s, i) => mesh.setMatrixAt(i, mm.makeTranslation(s[0], HEIGHT / 2 - 0.05, s[2])));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.renderOrder = 2;
  return mesh;
}
export function makeWorldSky(THREE, { t }) {
  const sky = new THREE.ShaderMaterial({
    uniforms: { uT: { value: t } },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: 'varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
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
          }`,
  });
  const dm = new THREE.Mesh(new THREE.SphereGeometry(48, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2), sky);
  dm.renderOrder = -10;
  dm.frustumCulled = false;
  return dm;
}
