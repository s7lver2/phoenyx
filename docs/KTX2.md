# Texturas comprimidas KTX2/Basis

Phoenyx sube texturas KTX2 (Basis Universal) a la GPU ya comprimidas, con sus mipmaps incluidos. En el banco de fidelidad (22 modelos de Backrooms en una escena) la VRAM de texturas baja de **74,3 MB a 18,6 MB (4×)** sin aumentar lo que se descarga. Solo se ha medido en Chrome (WebGPU, Windows).

## Cómo funciona

1. `tools/ktx_convert.mjs` convierte las texturas de un GLB (WebP/PNG/JPEG) a KTX2 con mipmaps y declara `KHR_texture_basisu` (requerida). La geometría, incluida la comprimida con meshopt, no se toca: el GLB se reescribe a nivel de bytes.
2. En el navegador, `KTX2Loader` (el de three 0.160.1, copiado en `packages/phoenyx/src/jsm/loaders/`) transcodifica con el transcodificador wasm de Basis al formato que admita la GPU. `GLTFLoader` ya trae la extensión `KHR_texture_basisu`.
3. `TextureCache` (`textures.ts`) sube cada `CompressedTexture` con `Gl::set_texture_compressed` (`phoenyx-gl`), sin tocar los mipmaps.

El dispositivo pide las características `texture-compression-bc`, `-etc2` y `-astc` que ofrezca el adaptador. `renderer.extensions.has(...)` las anuncia con los nombres de WebGL, de modo que `KTX2Loader.detectSupport(renderer)` elige solo:

| GPU | Formato al que se transcodifica |
|---|---|
| escritorio (BC) | BC7 (UASTC y ETC1S) |
| móvil / Apple (ASTC) | ASTC 4x4 |
| ETC2 sin ASTC | ETC2 RGBA |
| ninguna | RGBA8: el loader transcodifica y `set_texture_compressed` lo sube igual (4× más VRAM) |

Se admiten también DXT1/3/5, ETC1 y ETC2 RGB. Si la GPU no admite el formato, la textura no se dibuja y se avisa por consola una vez.

## Convertir

Una vez por máquina, compilar el `basisu` oficial (usa la fuente que baja cargo con `basis-universal-sys`, CMake y MSVC):

```
node tools/build-basisu.mjs
```

Después, para GLB (un archivo o una carpeta entera, conserva la estructura):

```
node tools/ktx_convert.mjs glb  web/models  web/models-ktx  --report informe.json
node tools/ktx_convert.mjs tex  texturas/   salida/                                  # PNG/JPG/WebP sueltos a .ktx2
```

Opciones: `--mode auto|uastc|etc1s`, `--q N` (ETC1S, 220 por defecto), `--normal-mode uastc|etc1s`, `--normal-q N`, `--uastc-level N`, `--rdo X`, `--jobs N`. El tipo de cada textura sale de su uso en el material: `baseColor` y emisivo van en sRGB, el resto lineal, y las normales con ajuste de normales. Los lados que no sean múltiplo de 4 se redondean (WebGPU exige bloques enteros en el nivel base). Los resultados se guardan en caché (`%TEMP%/phoenyx-ktx-cache`), así que repetir es rápido.

### Qué codec usar

Medido sobre los 142 GLB de Backrooms (393 texturas, 31,35 MB de imágenes WebP/PNG):

| Ajuste | Tamaño | Error en la captura (media / p99) |
|---|---|---|
| ETC1S q128, normales UASTC | 40,3 MB | 0,24 / 9 |
| **ETC1S q220, normales ETC1S q255 (por defecto)** | **28,1 MB** | 0,20 / 7 |
| UASTC en todo | 141 MB | 0,06 / 2 |

El ETC1S pesa lo mismo que el WebP ya optimizado del juego (el ahorro en red es pequeño: la ganancia es de VRAM). UASTC casi no se distingue del original pero pesa 4,5× más. Con q128 (el valor de basisu) se ve algo de borrosidad en texturas con detalle fino (el sillón), por eso el valor por defecto es 220. Las normales en UASTC cuestan 17–23 MB frente a 3,7 MB en ETC1S; RDO apenas ayuda.

## Cargar en el juego

```ts
import { WebGLRenderer } from 'three'; // alias de phoenyx
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const renderer = new WebGLRenderer({ canvas });
await renderer.ready;                       // la GPU tiene que estar iniciada: detectSupport lee sus características
const ktx2 = new KTX2Loader()
  .setTranscoderPath('/basis/')             // carpeta que sirve basis_transcoder.js y .wasm
  .detectSupport(renderer);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
const gltf = await loader.loadAsync('/models-ktx/backrooms/armchair.glb');
// al terminar de cargar todo: ktx2.dispose() libera los workers
```

Copiar `packages/phoenyx/basis/basis_transcoder.js` y `.wasm` (de three 0.160.1, unos 560 KB) a la carpeta pública del juego. El transcodificador solo se descarga cuando hay un GLB KTX2. Un `.ktx2` suelto se carga igual: `ktx2.loadAsync('/tex/a.ktx2')` devuelve una `CompressedTexture` que se puede poner en `material.map`.

Notas:

- La extensión está marcada como requerida: sin `setKTX2Loader`, `GLTFLoader` falla con un error claro. Para convivir con GLB antiguos y nuevos basta con dejar el loader siempre puesto.
- `renderer.info.memory.textureBytes` da la VRAM de texturas subidas (bytes, con mipmaps) y sirve para medir.
- Las texturas clonadas por `GLTFLoader` (una por muestreador) se suben una vez por clon, como ya ocurría con las imágenes normales.

## Medir

```
node tools/fidelity/build-harness.mjs
node tools/fidelity/ktx.mjs --variants plain,models-ktx,models-ktx+nocomp
```

`plain` lee `web/models` (originales), `models-ktx` los convertidos, y `+nocomp` finge una GPU sin compresión para probar la reserva a RGBA8. Escribe `fidelity/out/ktx/<variante>.png` y `ktx.json`; compara con `compare.mjs` (una carpeta con `ktx.png` por lado).

Resultado (escena `ktx`, 549 llamadas, 168 k triángulos, 49 texturas; Chrome/WebGPU en Windows):

| | VRAM de texturas | Descarga (GLB + transcodificador) | Listo (ms) | Error medio / p99 / píxeles >8 interiores |
|---|---|---|---|---|
| originales | 74,3 MB | 4,22 MB | 491 | — |
| KTX2 (BC) | 18,6 MB | 5,02 MB (0,5 MB es el wasm) | 844 | 0,20 / 7 / 263 |
| KTX2, reserva RGBA8 | 74,3 MB | 5,02 MB | 919 | 0,20 / 7 / 247 |
| KTX2 UASTC | 18,6 MB | 12,9 MB | — | 0,06 / 2 / 5 |

El umbral estricto del banco (`>8 int.` = 0) no se alcanza con ETC1S (263 de 921 600 píxeles, solo en texturas de detalle fino); en las capturas no se aprecia diferencia. El error es el mismo con la reserva RGBA8, así que viene del codificador y no de BC7. El tiempo de carga sube unos 350 ms por la transcodificación y el wasm; ocurre en workers.
