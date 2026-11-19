// Polvo de client/src/game/game.ts (mismo GLSL, 1600 motas) y de client/src/game/world.ts (mismo GLSL, 700 motas), con una semilla fija.
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
export function makeCamDust(THREE, { cam, t, beam, px }) {
  const rnd = rng(4242);
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(Array.from({ length: 1600 * 3 }, () => rnd() * 8), 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uCam: { value: cam.clone() }, uTime: { value: t }, uBeam: { value: beam }, uPx: { value: px } },
    vertexShader: `
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
        }`,
    fragmentShader: `
        varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(1.0, 0.93, 0.78) * vA * (1.0 - smoothstep(0.1, 0.5, r)), 1.0);
        }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(geo, mat);
  p.frustumCulled = false;
  return p;
}
export function makeWorldDust(THREE, { t }) {
  const rnd = rng(99);
  const N = 700, pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos.set([-9 + rnd() * 18, 0.2 + rnd() * 2.3, -7 + rnd() * 11], i * 3);
    seed[i] = rnd();
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: t } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
          uniform float uT; attribute float aSeed; varying float vA;
          void main() {
            vec3 p = position + vec3(sin(uT * 0.21 + aSeed * 40.0) * 0.18 + uT * 0.012, sin(uT * 0.17 + aSeed * 23.0) * 0.1 - uT * 0.006 * aSeed, cos(uT * 0.19 + aSeed * 31.0) * 0.14);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            float lamp = abs(mod(p.x - 0.75 + 1.5, 3.0) - 1.5);
            float cone = exp(-lamp * lamp * 1.6) * smoothstep(0.0, 1.2, p.y);
            float d = -mv.z;
            vA = (0.05 + 0.95 * cone) * smoothstep(1.2, 3.0, d) * (1.0 - smoothstep(8.0, 14.0, d)) * (0.4 + 0.6 * (0.5 + 0.5 * sin(uT * (0.7 + aSeed) + aSeed * 50.0)));
            gl_PointSize = (0.8 + aSeed * 1.2) * 11.0 / d;
            gl_Position = projectionMatrix * mv;
          }`,
    fragmentShader: `
          varying float vA;
          void main() {
            float r = length(gl_PointCoord - 0.5) * 2.0;
            gl_FragColor = vec4(vec3(1.0, 0.86, 0.6) * smoothstep(1.0, 0.0, r) * vA * 0.5, 1.0);
          }`,
  });
  const p = new THREE.Points(pg, mat);
  p.frustumCulled = false;
  return p;
}
