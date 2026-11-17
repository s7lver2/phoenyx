// Sala de prueba de la fase 1, escrita solo con la API de three. Se empaqueta dos veces (three real y phoenyx): ver tools/fidelity/build-harness.mjs.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { makePrueba } from './games/prueba.js';
import { makeJet } from './games/waterjet.js';
import { FilmShader, VhsShader } from './games/vhsPass.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

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

if (sceneId === 'luces') {
  // hemisferio del juego y la linterna (SpotLight con penumbra y corte)
  scene.add(new THREE.HemisphereLight(0xfff1c4, 0x3a2c0c, 0.6));
  const sp = new THREE.SpotLight(0xfff6e0, 60, 22, 0.55, 0.75, 1.2);
  sp.position.set(-1, 2.2, 4);
  sp.target.position.set(1, 0, -3);
  scene.add(sp, sp.target);
}

if (sceneId === 'rect') {
  // tres paneles rectangulares como los de la piscina (1,1 x 0,28), de cara al suelo
  RectAreaLightUniformsLib.init();
  [[-2.5, 0], [0, 0], [2.5, 0]].forEach(([x, z], i) => {
    const r = new THREE.RectAreaLight(i === 1 ? 0xffd0a0 : 0xfff0d8, 6, 1.1, 0.28);
    r.position.set(x, 1.6, z + 1);
    r.rotation.x = -Math.PI / 2;
    scene.add(r);
  });
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


if (sceneId === 'inst') {
  // 20x20 cubos con matriz propia y color por instancia (solo 350 de 400 se dibujan: count a medias)
  const dummy = new THREE.Object3D();
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1 }), 400);
  const col = new THREE.Color();
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) * 0.5 - 4.75, z = Math.floor(i / 20) * 0.5 - 4.75;
    dummy.position.set(x, 0.15 + 0.2 * Math.abs(Math.sin(i * 0.7)), z);
    dummy.rotation.set(i * 0.1, i * 0.37, 0);
    dummy.scale.setScalar(0.6 + 0.8 * ((i * 7) % 10) / 10);
    dummy.updateMatrix();
    im.setMatrixAt(i, dummy.matrix);
    im.setColorAt(i, col.setHSL((i * 0.013) % 1, 0.7, 0.55));
  }
  im.count = 350;
  im.frustumCulled = false;
  scene.add(im);
  // otra malla instanciada sin color y transparente, dentro de un grupo desplazado
  const g2 = new THREE.Group();
  g2.position.set(1.5, 1.2, -3);
  g2.rotation.y = 0.4;
  const im2 = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshStandardMaterial({ color: 0x40a0ff, transparent: true, opacity: 0.6, roughness: 0.3, depthWrite: false }), 5);
  for (let i = 0; i < 5; i++) { dummy.position.set(i * 0.7 - 1.4, 0, i * 0.3); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); im2.setMatrixAt(i, dummy.matrix); }
  g2.add(im2);
  scene.add(g2);
}


// ---- geoms: todas las geometrias que usa el juego, en dos filas ----
if (sceneId === 'geoms') {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(0.7, 0); shape.lineTo(0.7, 0.5); shape.lineTo(0.35, 0.9); shape.lineTo(0, 0.5);
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.4, 0.5, 0.2), new THREE.Vector3(0.8, 0, 0.5), new THREE.Vector3(1.2, 0.6, 0)]);
  const list = [
    new THREE.BoxGeometry(0.7, 0.7, 0.7, 2, 2, 2),
    new THREE.SphereGeometry(0.4, 24, 16),
    new THREE.CylinderGeometry(0.3, 0.4, 0.8, 16, 2),
    new THREE.ConeGeometry(0.4, 0.8, 16),
    new THREE.CapsuleGeometry(0.25, 0.5, 6, 12),
    new THREE.TorusGeometry(0.35, 0.12, 12, 24),
    new THREE.OctahedronGeometry(0.45, 1),
    new THREE.DodecahedronGeometry(0.45),
    new THREE.LatheGeometry([new THREE.Vector2(0.01, 0), new THREE.Vector2(0.4, 0.1), new THREE.Vector2(0.25, 0.5), new THREE.Vector2(0.35, 0.8)], 20),
    new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 }),
    new THREE.TubeGeometry(curve, 24, 0.08, 8),
    new THREE.RingGeometry(0.2, 0.45, 24),
    new THREE.CircleGeometry(0.4, 24),
    new THREE.PlaneGeometry(0.8, 0.6, 3, 3),
  ];
  list.forEach((g, i) => {
    const row = i < 7 ? 0 : 1, c = i % 7;
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 14, 0.6, 0.55), roughness: 0.45, metalness: 0.1, side: i >= 11 ? THREE.DoubleSide : THREE.FrontSide });
    const o = new THREE.Mesh(g, m);
    o.position.set(c * 1.25 - 3.75, 0.55 + row * 1.4, 1.5 - row * 2);
    o.rotation.set(0.3 + i * 0.05, 0.6 + i * 0.2, 0);
    scene.add(o);
  });
}

// ---- modelos: GLB reales del juego con GLTFLoader + meshopt ----
let modelsDone = Promise.resolve();
if (sceneId === 'modelos' || sceneId === 'interior' || sceneId === 'piscina-sol' || sceneId.startsWith('pool-fx') || sceneId.startsWith('ao')) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const items = [
    ['/models/items/bat.glb', -3.2, 0.9, 0.5], ['/models/items/nokia.glb', -1.2, 0.5, 1.0], ['/models/items/locker.glb', 1.4, 1.0, 0.0], ['/models/cosmetics/bicorn_hat.glb', 3.4, 0.5, 1.0],
    ['/models/items/pokeball.glb', -2.2, 0.4, 2.8], ['/models/items/beer.glb', 0.2, 0.7, 3.0],
  ];
  modelsDone = Promise.all(items.filter((it) => sceneId === 'modelos' || (!it[0].includes('beer') && !((sceneId.startsWith('ao') || sceneId.startsWith('pool-fx')) && it[0].includes('bicorn')))).map(async ([url, x, size, z], i) => {
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    const box = new THREE.Box3().setFromObject(root);
    const s = size / Math.max(...box.getSize(new THREE.Vector3()).toArray());
    root.scale.setScalar(s);
    box.setFromObject(root);
    const c = box.getCenter(new THREE.Vector3());
    root.position.set(x - c.x, 0.1 - box.min.y, z - c.z);
    root.rotation.y = 0.5 + i * 0.3;
    scene.add(root);
  }));
}

// ---- sombras: linterna (SpotLight) y sol (DirectionalLight) con PCFSoftShadowMap como el juego ----
if (sceneId === 'sombra-spot' || sceneId === 'sombra-sol') {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // casters extra: una columna y una esfera para ver siluetas planas y curvas
  const col = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5), mMetal);
  col.position.set(0.5, 1, 1.5);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), mWall);
  ball.position.set(-1.5, 0.5, 0.5);
  scene.add(col, ball);
  if (sceneId === 'sombra-spot') {
    const sp = new THREE.SpotLight(0xfff6e0, 80, 22, 0.55, 0.75, 1.2);
    sp.position.set(-1, 2.2, 4.5);
    sp.target.position.set(0.5, 0, -2);
    sp.castShadow = true;
    sp.shadow.mapSize.set(1024, 1024);
    sp.shadow.radius = 4;
    sp.shadow.camera.near = 0.2;
    sp.shadow.camera.far = 22;
    sp.shadow.bias = -0.002;
    scene.add(sp, sp.target);
  } else {
    scene.children.find((o) => o.material === mCeil).visible = false;
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.5);
    sun.position.set(5, 7, 4);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 30 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);
  }
  scene.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
}

// ---- casos limite de sombras: BackSide, alphaTest, transparente, receiveShadow falso, instancias y mapa congelado ----
if (sceneId === 'sombra-casos') {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene.children.find((o) => o.material === mCeil).visible = false;
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.5);
  sun.position.set(4, 8, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 30 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const put = (geo, mat, x, y, z) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); scene.add(o); return o; };
  // caja con material BackSide (proyecta con las caras delanteras)
  put(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshStandardMaterial({ color: 0x4080c0, side: THREE.BackSide }), -3.5, 0.4, 2);
  // reja con alphaTest: solo proyecta el circulo
  const ring = canvasTex((g, n) => { g.clearRect(0, 0, n, n); g.fillStyle = '#fff'; g.beginPath(); g.arc(n / 2, n / 2, n * 0.4, 0, 7); g.fill(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(n / 2, n / 2, n * 0.22, 0, 7); g.fill(); }, 128, true);
  put(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshStandardMaterial({ map: ring, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xe0c0a0 }), -1.5, 1.3, 1.5);
  // transparente (la sombra es completa)
  put(new THREE.BoxGeometry(0.8, 1.2, 0.8), new THREE.MeshStandardMaterial({ color: 0xc04040, transparent: true, opacity: 0.4 }), 0.8, 0.6, 2);
  // instancias
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.9, 0.4), new THREE.MeshStandardMaterial({ color: 0x60a060 }), 3);
  const d = new THREE.Object3D();
  for (let i = 0; i < 3; i++) { d.position.set(2.6 + i * 0.7, 0.45, 1 - i * 0.6); d.updateMatrix(); im.setMatrixAt(i, d.matrix); }
  scene.add(im);
  // receiveShadow = false: un cubo bajo la sombra de la reja que no la recibe
  const noRecv = put(new THREE.BoxGeometry(0.6, 0.3, 0.6), new THREE.MeshStandardMaterial({ color: 0xd0d0d0 }), -0.4, 0.15, -1);
  scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = o !== noRecv; } });
  // mapa congelado: se pinta una vez y no se repinta (autoUpdate = false)
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
}

// ---- interior y piscina con modelos reales del juego proyectando sombra ----
if (sceneId === 'interior' || sceneId === 'piscina-sol' || sceneId.startsWith('pool-fx') || sceneId === 'entidades-pool') {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (sceneId === 'interior') {
    scene.add(new THREE.HemisphereLight(0xfff1c4, 0x3a2c0c, 0.16));
    const sp = new THREE.SpotLight(0xfff6e0, 90, 22, 0.55, 0.75, 1.2);
    sp.position.set(0, 1.6, 5.5);
    sp.target.position.set(0.5, 0.3, 0);
    sp.castShadow = true;
    sp.shadow.mapSize.set(2048, 2048);
    sp.shadow.radius = 4;
    sp.shadow.camera.near = 0.2;
    sp.shadow.camera.far = 22;
    sp.shadow.bias = -0.002;
    scene.add(sp, sp.target);
  } else {
    scene.children.find((o) => o.material === mCeil).visible = false;
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.5);
    sun.position.set(-4, 7, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 30 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    // instancias del juego sobre el suelo
    const dm = new THREE.Object3D();
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.6, 0.3), new THREE.MeshStandardMaterial({ color: 0x80a0c0 }), 6);
    for (let i = 0; i < 6; i++) { dm.position.set(-2.5 + i * 0.5, 0.3, -2.5 - (i % 2) * 0.6); dm.updateMatrix(); im.setMatrixAt(i, dm.matrix); }
    scene.add(im);
  }
  modelsDone = modelsDone.then(() => scene.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } }));
}

// ---- escena 'rt': una escena pequena dibujada a render targets y mostrada como map (pantallas de vents.ts, snap de game.ts) ----
let draw = () => renderer.render(scene, camera);
if (sceneId === 'rt') {
  const inner = new THREE.Scene();
  inner.background = new THREE.Color(0x203040);
  inner.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const dl = new THREE.DirectionalLight(0xfff0d0, 2);
  dl.position.set(2, 3, 1);
  inner.add(dl);
  [[-0.9, 0xc04040], [0, 0x40a060], [0.9, 0x4060c0]].forEach(([x, c], i) => {
    const m = new THREE.Mesh(i === 1 ? new THREE.SphereGeometry(0.4, 24, 16) : new THREE.BoxGeometry(0.6, 0.6 + i * 0.2, 0.6), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: i === 2 ? 0.7 : 0 }));
    m.position.set(x, 0.3, 0);
    m.rotation.y = 0.5 * i;
    inner.add(m);
  });
  const ic = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 20);
  ic.position.set(0.4, 1.1, 3);
  ic.lookAt(0, 0.3, 0);
  const rt = new THREE.WebGLRenderTarget(512, 384, { type: THREE.HalfFloatType });
  const rt2 = new THREE.WebGLRenderTarget(320, 240);
  const show = (tex, x, w) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.75), new THREE.MeshBasicMaterial({ map: tex }));
    p.position.set(x, 1.5, 0);
    scene.add(p);
  };
  show(rt.texture, -1.4, 2.2);
  show(rt2.texture, 1.4, 1.6);
  draw = () => {
    renderer.setRenderTarget(rt);
    renderer.render(inner, ic);
    renderer.setRenderTarget(rt2);
    renderer.render(inner, ic);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  };
}

// ---- escena 'composer': EffectComposer con RenderPass y ShaderPass(CopyShader); un pase insertado y quitado en caliente ----
if (sceneId === 'composer') {
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);
  composer.setSize(1280, 720);
  composer.addPass(new RenderPass(scene, camera));
  const tmp = new ShaderPass(CopyShader);
  composer.insertPass(tmp, 1);
  composer.removePass(tmp);
  const copy = new ShaderPass(CopyShader);
  copy.uniforms.opacity.value = 0.8;
  composer.addPass(copy);
  draw = () => composer.render(0);
}

// ---- escena 'composer-out': RenderPass + OutputPass (tone mapping ACES y sRGB en el composer) ----
if (sceneId === 'composer-out') {
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);
  composer.setSize(1280, 720);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  draw = () => composer.render(0);
}

// ---- escena 'bloom': fluorescentes de las Poolrooms (emisivos fuertes) con RenderPass -> UnrealBloomPass -> OutputPass ----
if (sceneId === 'bloom' || sceneId === 'bloom-fuerte' || sceneId === 'bloom-cero') {
  const tubes = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 5.2) });
  [-2, 0, 2].forEach((x) => {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.08, 1.8), tubes);
    t.position.set(x * 1.5, 2.35, -1.5);
    scene.add(t);
  });
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);
  composer.setSize(1280, 720);
  composer.addPass(new RenderPass(scene, camera));
  const hotel = sceneId === 'bloom-fuerte';
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), sceneId === 'bloom-cero' ? 0 : hotel ? 0.62 : 0.55, 0.6, hotel ? 0.9 : 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  draw = () => composer.render(0);
}

// ---- escena 'smaa': bordes inclinados con RenderPass -> OutputPass -> SMAAPass (como el juego en las Poolrooms) ----
if (sceneId.startsWith('smaa')) {
  [[-1.6, 0.4], [0.2, -0.3], [1.5, 0.9]].forEach(([x, r], i) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.4, 0.7), new THREE.MeshStandardMaterial({ color: 0xe0e0d0, roughness: 0.6 }));
    b.position.set(x, 0.7, 0.5 - i * 0.8);
    b.rotation.set(0.2 * i, r, 0.35 - 0.2 * i);
    scene.add(b);
  });
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);
  composer.setSize(1280, 720);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  const smaa = new SMAAPass(1280, 720);
  composer.addPass(smaa);
  draw = () => composer.render(0);
  if (sceneId !== 'smaa') {
    // depuracion: muestra el RT intermedio del SMAA tal cual
    const dbg = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, opacity: { value: 1 } }, vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader }));
    draw = () => {
      composer.render(0);
      dbg.material.uniforms.tDiffuse.value = sceneId === 'smaa-area' ? smaa.areaTexture : sceneId === 'smaa-search' ? smaa.searchTexture : (sceneId === 'smaa-edges' ? smaa.edgesRT : smaa.weightsRT).texture;
      renderer.setRenderTarget(null);
      dbg.render(renderer);
    };
  }
}

// ---- escena 'ao-normales': la sala y los modelos dibujados con scene.overrideMaterial = MeshNormalMaterial (las normales de GTAOPass) ----
if (sceneId === 'ao-normales' || sceneId === 'skin-normales') {
  scene.children.find((o) => o.material === mCeil)?.material;
  const nm = new THREE.MeshNormalMaterial();
  draw = () => {
    scene.overrideMaterial = nm;
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
  };
}

// ---- escenas 'ao*': GTAOPass con los valores del juego (radio 0.9, thickness 1.2, 8 muestras, mitad de resolucion) ----
// pool-fx / pool-fx-sinao = la cadena sobre las Poolrooms con sol y sombra (sin ao = GTAOPass desactivado, como el ajuste del juego)
// ao = cadena completa RenderPass -> GTAO -> Bloom -> Output -> SMAA; ao-ao / ao-denoise / ao-depth / ao-normal = salidas de depuracion de GTAOPass
if ((sceneId.startsWith('ao') && sceneId !== 'ao-normales') || sceneId.startsWith('pool-fx') || sceneId === 'entidades-pool') {
  // el ruido del denoise (SimplexNoise) usa Math.random: semilla fija para que three y Phoenyx generen la misma textura
  let seed = 12345;
  Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);
  composer.setSize(1280, 720);
  composer.addPass(new RenderPass(scene, camera));
  const ao = new GTAOPass(scene, camera, 640, 360);
  ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.2, scale: 1, samples: 8 });
  ao.blendIntensity = 0.85;
  const outs = { 'ao-ao': GTAOPass.OUTPUT.AO, 'ao-denoise': GTAOPass.OUTPUT.Denoise, 'ao-depth': GTAOPass.OUTPUT.Depth, 'ao-normal': GTAOPass.OUTPUT.Normal };
  if (sceneId in outs) ao.output = outs[sceneId];
  composer.addPass(ao);
  if (sceneId === 'pool-fx-sinao') ao.enabled = false;
  // pool-fx-salida: solo RenderPass -> OutputPass (el fondo scene.background se ve por el techo oculto)
  if (sceneId === 'pool-fx-salida') composer.removePass(ao);
  if (sceneId === 'ao' || sceneId === 'entidades-pool' || (sceneId.startsWith('pool-fx') && sceneId !== 'pool-fx-salida')) {
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.6, 0.92));
    composer.addPass(new OutputPass());
    composer.addPass(new SMAAPass(1280, 720));
  } else composer.addPass(new OutputPass());
  draw = () => composer.render(0);
}

// ---- escena 'sh-waterjet': el chorro del juego (Points con su shader), 288 gotas con una semilla fija ----
if (sceneId === 'sh-waterjet') scene.add(makeJet(THREE));

// ---- escena 'sh-vhs': RenderPass -> OutputPass -> FilmShader -> VhsShader del juego, con el tiempo fijo ----
if (sceneId === 'sh-vhs') {
  const corrupt = Number(q.get('corrupt') ?? 0);
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);
  composer.setSize(1280, 720);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  const film = new ShaderPass(FilmShader);
  Object.assign(film.uniforms, { uTime: { value: 1.7 }, uRes: { value: new THREE.Vector2(1280, 720) }, uMove: { value: 1 }, uMad: { value: 0.35 }, uVhs: { value: 1 }, uWarm: { value: 0.6 } });
  composer.addPass(film);
  // tPrev: un fotograma viejo cualquiera (aqui, un dibujo de rayas) para los trozos congelados
  const prev = new THREE.CanvasTexture((() => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const g = c.getContext('2d');
    for (let x = 0; x < 64; x += 8) { g.fillStyle = x % 16 ? '#c0c060' : '#303090'; g.fillRect(x, 0, 8, 36); }
    return c;
  })());
  prev.colorSpace = THREE.SRGBColorSpace;
  const vhs = new ShaderPass(VhsShader);
  Object.assign(vhs.uniforms, { tPrev: { value: prev }, uTime: { value: 2.3 }, uRes: { value: new THREE.Vector2(1280, 720) }, uMove: { value: 1 }, uLow: { value: 0 }, uCorrupt: { value: corrupt }, uFlash: { value: 0.05 }, uBlack: { value: 0 }, uAspect: { value: 16 / 9 }, uAmount: { value: 1 }, uPool: { value: 0.5 } });
  composer.addPass(vhs);
  draw = () => composer.render(0);
}

// ---- escena 'skin': cilindros con SkinnedMesh de 3 huesos (generados en codigo), mismo esqueleto base clonado con distinta pose ----
// la pose sale de mixer.setTime (independiente del numero de fotogramas), asi three y phoenyx dibujan exactamente la misma
function makeSkinned(x, t, mat) {
  const h = 4, seg = 2, geo = new THREE.CylinderGeometry(0.45, 0.45, h, 16, 8, false);
  const pos = geo.attributes.position, idx = [], w = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) + h / 2, k = Math.min(Math.floor(y / seg), 1), f = (y - k * seg) / seg;
    idx.push(k, k + 1, 0, 0);
    w.push(1 - f, f, 0, 0);
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  const b0 = new THREE.Bone(), b1 = new THREE.Bone(), b2 = new THREE.Bone();
  b0.position.y = -h / 2; b1.position.y = seg; b2.position.y = seg;
  b0.add(b1); b1.add(b2);
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.add(b0);
  mesh.bind(new THREE.Skeleton([b0, b1, b2]));
  mesh.position.set(x, 2.1, 0);
  mesh.scale.setScalar(0.55);
  const q = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
  const track = (name, a) => new THREE.QuaternionKeyframeTrack(name, [0, 1, 2], [...q(0).toArray(), ...q(a).toArray(), ...q(-a).toArray()]);
  const clip = new THREE.AnimationClip('doblar', 2, [track('.bones[1].quaternion', 0.9), track('.bones[2].quaternion', 0.7)]);
  const mixer = new THREE.AnimationMixer(mesh);
  mixer.clipAction(clip).play();
  mixer.setTime(t);
  scene.add(mesh);
  return mesh;
}
if (sceneId === 'skin' || sceneId === 'skin-sombra' || sceneId === 'skin-normales') {
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc86a3a, roughness: 0.55, metalness: 0.1 });
  makeSkinned(-1.4, 0.6, skinMat);
  makeSkinned(1.4, 1.5, skinMat);
  if (sceneId === 'skin-sombra') {
    // fuera de pantalla (junto a la camara): uno con frustumCulled por defecto y otro sin culling; su sombra puede entrar en cuadro
    makeSkinned(2.6, 0.9, skinMat).position.z = 8;
    const sinCulling = makeSkinned(-2.6, 1.2, skinMat);
    sinCulling.position.z = 8;
    sinCulling.frustumCulled = false;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene.children.find((o) => o.material === mCeil).visible = false;
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.5);
    sun.position.set(5, 7, 6);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 30 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    scene.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  }
}

// ---- escenas 'sh-*': ShaderMaterial del juego con el tiempo fijo ----
if (sceneId === 'sh-prueba') {
  const map = new THREE.CanvasTexture((() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#e0a030' : '#2060c0'; g.fillRect(x * 8, y * 8, 8, 8); }
    g.fillStyle = '#e04030';
    g.fillRect(0, 0, 20, 12);
    return c;
  })());
  map.colorSpace = THREE.SRGBColorSpace;
  // el mismo shader con uniformes distintos por malla (cada dibujo lee los suyos): plano de doble cara, caja y plano aditivo
  const a = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.6), makePrueba(THREE, { map, color: 0x30c070, time: 0.4 }));
  a.position.set(-2.2, 1.5, 0);
  a.material.side = THREE.DoubleSide;
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), makePrueba(THREE, { map, color: 0xd04060, time: 1.9 }));
  b.position.set(0.4, 1.2, 1);
  b.rotation.y = 0.6;
  b.material.transparent = false;
  const c = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.6), makePrueba(THREE, { map, color: 0x4060ff, time: 3.1 }));
  c.position.set(2.6, 1.5, -1);
  c.material.blending = THREE.AdditiveBlending;
  c.material.depthWrite = false;
  scene.add(a, b, c);
}

// ---- escena 'entidades': los GLB con esqueleto del juego, clonados con SkeletonUtils y animados con AnimationMixer ----
// el mezclador avanza con pasos fijos al cargar (idle -> fundido cruzado a otro clip con timeScale 1, 0.5, 0 y -1): la pose no depende del numero de fotogramas
if (sceneId === 'entidades' || sceneId === 'entidades-pool') {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // [url, altura, x de cada clon, clip inicial, clip final por clon, timeScale por clon]
  const defs = [
    ['/models/backrooms/hazmat.glb', 1.8, [-3.6, -2.2], 'Neutral Idle', ['Slow Run', 'Reloading'], [1, 0.5]],
    ['/models/backrooms/partygoer.glb', 1.8, [-0.7, 0.7], 'Happy Idle', ['Macarena Dance', 'Dwarf Walk'], [0, -1]],
    ['/models/parking/skinwalker.glb', 1.8, [2.2, 3.6], 'idle', ['attack', 'run'], [1, 0.5]],
  ];
  modelsDone = Promise.all(defs.map(async ([url, height, xs, first, seconds, scales], d) => {
    const gltf = await loader.loadAsync(url);
    xs.forEach((x, i) => {
      const root = SkeletonUtils.clone(gltf.scene);
      root.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
      scene.add(root);
      const mixer = new THREE.AnimationMixer(root);
      const a = mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, first));
      a.play();
      mixer.update(0.3 + 0.17 * i);
      const b = mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, seconds[i]));
      b.timeScale = scales[i];
      a.fadeOut(0.6);
      b.reset().fadeIn(0.6).play();
      mixer.update(0.25);
      // se escala segun la caja de la pose (las mallas con piel la calculan con los huesos)
      root.updateMatrixWorld(true);
      root.traverse((o) => { if (o.isSkinnedMesh) (o.skeleton.update(), o.computeBoundingBox()); });
      const box = new THREE.Box3().setFromObject(root);
      const k = height / (box.max.y - box.min.y);
      root.scale.setScalar(k);
      root.position.set(x, 0.1 - box.min.y * k, 0.8 - d * 0.6);
      root.rotation.y = 0.35 - i * 0.7;
      // en las Poolrooms (sol con sombra) las entidades proyectan y reciben sombra
      if (sceneId === 'entidades-pool') root.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
    });
  }));
}

// contrato de tools/fidelity/capture.mjs
let timer = 0;
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
Promise.all([renderer.ready, modelsDone]).then(() => (window.__capture.ready = true));
