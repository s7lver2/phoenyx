// Gas de client/src/game/vents.ts (mismo GLSL, textura de bocanada y parametros), con una semilla fija en vez de Math.random.
export function makeVentGas(THREE, { t }) {
  const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const pc = Object.assign(document.createElement('canvas'), { width: 128, height: 128 }), pg = pc.getContext('2d');
  for (let i = 0; i < 14; i++) {
    const x = 64 + (hash(i, 31) - 0.5) * 56, y = 64 + (hash(i, 32) - 0.5) * 56, r = 22 + hash(i, 33) * 26, gr = pg.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.32)'), gr.addColorStop(1, 'rgba(255,255,255,0)');
    pg.fillStyle = gr, pg.fillRect(0, 0, 128, 128);
  }
  const map = new THREE.CanvasTexture(pc);
  map.colorSpace = THREE.SRGBColorSpace;
  let s = 777;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const DUCT_H = 1.6, CELL = 3, N = 46, cells = [{ x: -1, y: 0 }, { x: 0, y: -1 }];
  const pos = new Float32Array(cells.length * N * 3), seed = new Float32Array(cells.length * N);
  cells.forEach((c, k) => {
    for (let i = 0; i < N; i++) {
      const j = k * N + i;
      pos.set([(c.x + rnd()) * CELL, rnd() * DUCT_H, (c.y + rnd()) * CELL], j * 3);
      seed[j] = rnd();
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: t }, uMap: { value: map } },
    transparent: true,
    depthWrite: false,
    vertexShader: `
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
        }`,
    fragmentShader: `
        uniform sampler2D uMap; varying float vA; varying float vS; varying float vR;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float c = cos(vR), sn = sin(vR);
          vec2 uv = vec2(c * q.x - sn * q.y, sn * q.x + c * q.y) + 0.5;
          float m = texture2D(uMap, uv).a * smoothstep(0.5, 0.2, length(q));
          vec3 col = mix(vec3(0.30, 0.62, 0.12), vec3(0.62, 0.92, 0.28), vS);
          gl_FragColor = vec4(col * (0.8 + 0.5 * m), m * vA * 0.9);
        }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
