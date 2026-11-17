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
document.body.style.overflow = 'hidden';
renderer.domElement.style.display = 'block';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// niebla: por la escena (exp, lineal) o con ?fog=exp|lineal (para las escenas basic)
const fogMode = q.get('fog') ?? (sceneId === 'exp' || sceneId === 'lineal' ? sceneId : 'none');
if (fogMode === 'exp') scene.fog = new THREE.FogExp2(0x15120a, 0.07);
else if (fogMode === 'lineal') scene.fog = new THREE.Fog(0x15120a, 3, 25);
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


// ---- escena 'tex': texturas de lienzo, de datos y colores por vertice ----
const texScene = sceneId === 'tex';
const canvasTex = (draw, size = 256, srgb = true) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};
let mFloorT = mFloor, mWallT = mWall;
if (texScene) {
  const checker = canvasTex((g, n) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 ? '#8a7a3a' : '#c8b45a';
      g.fillRect((x * n) / 8, (y * n) / 8, n / 8, n / 8);
    }
    g.strokeStyle = '#302810';
    g.lineWidth = 3;
    g.strokeRect(1, 1, n - 2, n - 2);
  });
  checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  checker.repeat.set(5, 5);
  const rough = canvasTex((g, n) => {
    const gr = g.createLinearGradient(0, 0, n, 0);
    gr.addColorStop(0, '#202020');
    gr.addColorStop(1, '#f0f0f0');
    g.fillStyle = gr;
    g.fillRect(0, 0, n, n);
  }, 128, false);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  mFloorT = new THREE.MeshStandardMaterial({ map: checker, roughnessMap: rough, roughness: 1, metalness: 0 });
  const bricks = canvasTex((g, n) => {
    g.fillStyle = '#b09a50';
    g.fillRect(0, 0, n, n);
    g.strokeStyle = '#5a4a20';
    g.lineWidth = 4;
    for (let r = 0; r < 8; r++) {
      const y = (r * n) / 8;
      g.beginPath(); g.moveTo(0, y); g.lineTo(n, y); g.stroke();
      for (let k = 0; k < 4; k++) { const x = ((k + (r % 2) * 0.5) * n) / 4; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + n / 8); g.stroke(); }
    }
    g.fillStyle = '#e04030';
    g.fillRect(10, 10, 40, 24); // marca para ver la orientacion (flipY)
  });
  bricks.wrapS = bricks.wrapT = THREE.RepeatWrapping;
  bricks.repeat.set(3, 1);
  mWallT = new THREE.MeshStandardMaterial({ map: bricks, roughness: 0.8, metalness: 0 });
}

const box = (w, h, d, m, x, y, z) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  scene.add(o);
  return o;
};
box(12, 0.1, 12, mFloorT, 0, -0.05, 0);
box(12, 0.1, 12, mCeil, 0, 3.05, 0);
box(12, 3, 0.1, mWallT, 0, 1.5, -6);
box(12, 3, 0.1, mWallT, 0, 1.5, 6);
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


if (texScene) {
  // paneles emisivos con mapa emisivo
  const emis = canvasTex((g, n) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, n, n);
    g.fillStyle = '#40ff90'; g.font = 'bold 120px sans-serif'; g.fillText('EM', 30, 150);
    g.fillStyle = '#ff4080'; g.fillRect(0, n - 30, n, 20);
  });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: emis, emissiveIntensity: 0.9 }));
  panel.position.set(-5.9, 1.5, -1); panel.rotation.y = Math.PI / 2; scene.add(panel);
  // alphaTest: disco con borde suave, doble cara
  const disc = canvasTex((g, n) => {
    g.clearRect(0, 0, n, n);
    const gr = g.createRadialGradient(n / 2, n / 2, 10, n / 2, n / 2, n / 2);
    gr.addColorStop(0, 'rgba(255,200,60,1)'); gr.addColorStop(0.9, 'rgba(255,60,60,1)'); gr.addColorStop(1, 'rgba(255,60,60,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(n / 2, n / 2, n / 2 - 2, 0, 7); g.fill();
  });
  const cut = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshStandardMaterial({ map: disc, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6 }));
  cut.position.set(0.4, 1.0, 1.5); scene.add(cut);
  // transparente con mapa (degradado de alfa)
  const fade = canvasTex((g, n) => {
    const gr = g.createLinearGradient(0, 0, n, 0);
    gr.addColorStop(0, 'rgba(40,200,255,0)'); gr.addColorStop(1, 'rgba(40,200,255,1)');
    g.fillStyle = gr; g.fillRect(0, 0, n, n);
  });
  const veil = new THREE.Mesh(new THREE.PlaneGeometry(2, 1.2), new THREE.MeshBasicMaterial({ map: fade, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  veil.position.set(2.4, 1.0, 0.2); veil.rotation.y = -0.3; scene.add(veil);
  // textura con rotacion, desplazamiento y repeticion en un cubo
  const rot = canvasTex((g, n) => { g.fillStyle = '#fff'; g.fillRect(0, 0, n, n); g.fillStyle = '#2060d0'; g.fillRect(0, 0, n / 2, n / 2); g.fillStyle = '#d02060'; g.fillRect(n / 2, n / 2, n / 2, n / 2); });
  rot.wrapS = rot.wrapT = THREE.MirroredRepeatWrapping;
  rot.center.set(0.5, 0.5); rot.rotation = 0.5; rot.offset.set(0.1, 0.2); rot.repeat.set(1.5, 1.5);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshStandardMaterial({ map: rot, roughness: 0.5 }));
  cube.position.set(-1.8, 0.45, 2.4); cube.rotation.y = 0.6; scene.add(cube);
  // DataTexture 4x4 con filtro Nearest al ampliar y sin mipmaps
  const d = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) { const c = (i + (i >> 2)) % 2 ? 255 : 40; d.set([c, i * 16, 255 - i * 16, 255], i * 4); }
  const dt = new THREE.DataTexture(d, 4, 4, THREE.RGBAFormat);
  dt.magFilter = THREE.NearestFilter; dt.minFilter = THREE.NearestFilter; dt.generateMipmaps = false; dt.colorSpace = THREE.SRGBColorSpace; dt.needsUpdate = true;
  const dcube = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshBasicMaterial({ map: dt }));
  dcube.position.set(1.2, 0.4, 2.8); dcube.rotation.y = -0.4; scene.add(dcube);

  // bumpMap: relieve de circulos sobre un panel y sobre el muro del fondo (bumpScale distinto)
  const height = canvasTex((g, n) => {
    g.fillStyle = '#404040'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 12; i++) { const gr = g.createRadialGradient((i % 4) * 64 + 32, Math.floor(i / 4) * 80 + 40, 2, (i % 4) * 64 + 32, Math.floor(i / 4) * 80 + 40, 28); gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#404040'); g.fillStyle = gr; g.beginPath(); g.arc((i % 4) * 64 + 32, Math.floor(i / 4) * 80 + 40, 28, 0, 7); g.fill(); }
  }, 256, false);
  const bumpCube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xc8b070, bumpMap: height, bumpScale: 2.5, roughness: 0.6 }));
  bumpCube.position.set(-3.2, 0.5, -3); bumpCube.rotation.y = 0.5; scene.add(bumpCube);
  // normalMap: cupula calculada a mano
  const nm = canvasTex((g, n) => {
    const im = g.createImageData(n, n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const u = ((x % 128) - 64) / 64, v = ((y % 128) - 64) / 64, r2 = u * u + v * v;
      const z = Math.sqrt(Math.max(0.05, 1 - Math.min(1, r2))), nx = r2 < 1 ? u : 0, ny = r2 < 1 ? -v : 0, l = Math.hypot(nx, ny, z);
      im.data.set([(nx / l * 0.5 + 0.5) * 255, (ny / l * 0.5 + 0.5) * 255, (z / l * 0.5 + 0.5) * 255, 255], (y * n + x) * 4);
    }
    g.putImageData(im, 0, 0);
  }, 256, false);
  const nmPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), new THREE.MeshStandardMaterial({ color: 0xb0b0c8, normalMap: nm, normalScale: new THREE.Vector2(1, 1), roughness: 0.35, metalness: 0.1, side: THREE.DoubleSide }));
  nmPlane.position.set(3.6, 1.2, -4.9); scene.add(nmPlane);
  // colores por vertice
  const vg = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  const vc = new Float32Array(vg.attributes.position.count * 3);
  for (let i = 0; i < vg.attributes.position.count; i++) { const p = vg.attributes.position; vc.set([0.5 + p.getX(i), 0.5 + p.getY(i), 0.5 + p.getZ(i)], i * 3); }
  vg.setAttribute('color', new THREE.BufferAttribute(vc, 3));
  const vbox = new THREE.Mesh(vg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
  vbox.position.set(3.5, 0.4, 3); vbox.rotation.set(0.3, 0.5, 0); scene.add(vbox);
}

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
