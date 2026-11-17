// Sala de prueba de la fase 1, escrita solo con la API de three. Se empaqueta dos veces (three real y phoenyx): ver tools/fidelity/build-harness.mjs.
import * as THREE from 'three';

const q = new URLSearchParams(location.search);
const sceneId = q.get('scene') ?? 'exp';
const oneLight = q.get('lights') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.72;
renderer.setPixelRatio(1);
renderer.setSize(1280, 720);
renderer.domElement.className = 'br-gl';
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
if (sceneId === 'exp') scene.fog = new THREE.FogExp2(0x15120a, 0.07);
else if (sceneId === 'lineal') scene.fog = new THREE.Fog(0x15120a, 3, 25);
scene.background = new THREE.Color(0x15120a);

const camera = new THREE.PerspectiveCamera(75, 1280 / 720, 0.1, 100);
camera.position.set(0, 1.6, 5.2);
camera.lookAt(0, 1.3, -6);

// materiales: con 'basic' todo se pinta sin luces
const basic = sceneId === 'basic';
const std = (color, roughness, metalness) =>
  basic ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshStandardMaterial({ color, roughness, metalness });
const mFloor = std(0xb9a85a, 0.9, 0);
const mWall = std(0xc9b86c, 0.75, 0);
const mCeil = std(0xcfc8a0, 0.6, 0);
const mMetal = std(0x8a8a82, 0.3, 0.8);

const box = (w, h, d, m, x, y, z) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  scene.add(o);
  return o;
};
box(12, 0.1, 12, mFloor, 0, -0.05, 0);
box(12, 0.1, 12, mCeil, 0, 3.05, 0);
box(12, 3, 0.1, mWall, 0, 1.5, -6);
box(12, 3, 0.1, mWall, 0, 1.5, 6);
box(0.1, 3, 12, mWall, -6, 1.5, 0);
box(0.1, 3, 12, mWall, 6, 1.5, 0);
box(0.6, 3, 0.6, mMetal, 3, 1.5, -2);

// tubos fluorescentes (emisivos, sin luces) y una luz puntual bajo cada uno
const tube = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
const spots = [[-3, -3], [3, -3], [-3, 0], [3, 0], [-3, 3], [3, 3]];
spots.slice(0, oneLight ? 1 : 6).forEach(([x, z], i) => {
  box(1.2, 0.05, 0.2, tube, x, 3, z);
  if (basic) return;
  const l = new THREE.PointLight(0xfff2c0, 14, i % 2 ? 9 : 0, 2);
  l.position.set(x, 2.8, z);
  scene.add(l);
});
if (!basic && !oneLight) {
  const d = new THREE.DirectionalLight(0xaab4ff, 0.25);
  d.position.set(2, 5, 3);
  scene.add(d);
  scene.add(new THREE.AmbientLight(0x303030, 1));
}

// objeto anidado: grupo rotado y escalado con tres cubos
const g = new THREE.Group();
g.position.set(-3.5, 0.6, 1);
g.rotation.set(0.2, 0.6, 0.1);
g.scale.set(1.5, 1, 0.8);
[[0, 0, 0], [0.9, 0.5, 0.3], [-0.9, 0.2, -0.4]].forEach(([x, y, z], i) => {
  const c = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), i === 1 ? mMetal : mWall);
  c.position.set(x, y, z);
  c.rotation.y = i * 0.5;
  g.add(c);
});
scene.add(g);

// sin niebla aunque la escena la tenga, y un plano transparente de doble cara
const nofog = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: 0xc02020, fog: false }));
nofog.position.set(1.5, 0.5, -4.5);
scene.add(nofog);
const glass = new THREE.Mesh(new THREE.PlaneGeometry(2, 1.4), new THREE.MeshBasicMaterial({ color: 0x4080ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
glass.position.set(-1.2, 1.2, 0.5);
glass.rotation.y = 0.4;
scene.add(glass);

// contrato de tools/fidelity/capture.mjs
let timer = 0;
const draw = () => renderer.render(scene, camera);
const loop = () => (draw(), (timer = requestAnimationFrame(loop)));
window.__capture = {
  ready: false,
  reseed() {},
  async advance(n) {
    const ri = renderer.info;
    ri.autoReset = false;
    for (let i = 0; i < n; i++) (ri.reset(), draw());
    await new Promise((r) => setTimeout(r, 50));
  },
  info() {
    const i = renderer.info;
    return { drawCalls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures };
  },
  release() {
    renderer.info.autoReset = true;
    cancelAnimationFrame(timer);
    loop();
  },
};
Promise.resolve(renderer.ready).then(() => (window.__capture.ready = true));
