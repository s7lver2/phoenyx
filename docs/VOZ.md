# phoenyx-voice: voz en tiempo real para el motor

Paquete nuevo del motor: `packages/phoenyx-voice` (TypeScript, sin dependencias de React ni del juego). El juego le da posiciones y le contesta preguntas de geometría; la librería se ocupa del micrófono, la red, el cifrado, los efectos y el sonido en el espacio.

## Objetivos

- Voz de alta calidad (Opus 48 kHz, 64 kb/s por defecto, FEC) con latencia baja.
- Sonido posicional con físicas del entorno: distancia, oclusión por paredes, reverb según la sala, Doppler.
- Modulación de la voz (efectos) configurable y en vivo.
- Cifrado de extremo a extremo: ni un servidor intermedio puede oír la voz.
- Transporte intercambiable (interfaz `Transport`): malla P2P ahora; un SFU queda como posible ampliación futura, no se construye por ahora.
- Micrófono gestionado **dentro del juego**: el juego pide el permiso del navegador una vez y, a partir de ahí, dispositivo, nivel, puerta de ruido y prueba se configuran en los ajustes del juego, no en el navegador.
- Todo configurable en vivo y con perfiles de calidad (`low` / `medium` / `high`).

## No objetivos (por ahora)

Grabación, transcripción, vídeo, mezcla en el servidor.

## Módulos

| Módulo | Qué hace |
|---|---|
| `mic` | Permiso (Permissions API + `getUserMedia`), lista de dispositivos, cambio en caliente, medidor de nivel, prueba con eco local. Expone `MicState`: `unknown / prompt / granted / denied / unavailable`. Si está denegado, explica cómo reactivarlo (el navegador no deja volver a preguntar). |
| `capture` | `AudioWorklet`: puerta de ruido, ganancia automática, VAD (detección de voz para no enviar silencio). |
| `fx` | Modulación: tono (pitch shift), robot (modulación en anillo), radio (paso banda + saturación), eco, grave/agudo. Cadena de efectos con parámetros automatizables; se aplica antes de codificar (los demás oyen la voz modulada). |
| `crypto` | Cifrado extremo a extremo con *insertable streams* (`RTCRtpScriptTransform`): AES-GCM por emisor, clave rotada al entrar/salir alguien. Intercambio de claves por ECDH (P-256) firmado con la identidad de la sala. |
| `transport/mesh` | WebRTC P2P (el actual de `voice.ts`, extraído). |
| `spatial` | Grafo Web Audio por emisor: HRTF, atenuación, Doppler, filtro de oclusión, bus de reverb. Pregunta al motor con `world.raycast(a, b)` y `world.roomSize(pos)`. |
| `config` | Esquema único de parámetros, perfiles, serialización y vistas previas. |

## API pública

```ts
const voice = createVoice({ transport: 'mesh' | 'sfu', quality: 'high', world, e2ee: true });
voice.mic.request();            // el permiso, desde un botón del juego
voice.mic.setDevice(id);
voice.fx.set({ preset: 'robot', pitch: -3 });
voice.setListener({ pos, forward, up });
voice.setEmitter(id, { pos, vel });
voice.on('speaking', (id, on) => ...);
voice.config.set(partial);      // todo en vivo
```

`world` es una interfaz mínima: `raycast(a, b) → { walls, thickness }` y `roomSize(pos) → m³`. El motor la implementa; los niveles dan presets de reverb.

## SFU

Descartado por ahora (decisión del autor). La interfaz `Transport` deja sitio para añadirlo después sin tocar el resto.

## Entregas

1. `mic` + `capture` + `fx`, y los ajustes de micrófono dentro del juego (sin SFU ni cifrado todavía).
2. `spatial` con oclusión y reverb; `transport/mesh` extraído de `voice.ts`; `voice.ts` pasa a ser un adaptador.
3. `crypto` (E2EE).

## Riesgos

- *Insertable streams* en Firefox: `RTCRtpScriptTransform` sí, la API antigua `createEncodedStreams` no. Se usa la estándar.
- El permiso del micrófono lo gestiona siempre el navegador: el juego no puede evitar el aviso, solo hacerlo una vez y guardar la configuración propia.

## Estado

- Entrega 1 hecha: `mic`, `capture`, `fx`.
- Entrega 2 hecha: `spatial` (distancia, HRTF, oclusión por paredes con `VoiceWorld.raycast`, reverb según `roomSize`, perfiles off/low/medium/high), `mesh` (transporte extraído de `voice.ts`) y `gridWorld` (mundo en cuadrícula). El juego lo conecta para el laberinto del Nivel 0 y las Suites; Poolrooms y parking usan solo distancia + reverb del preajuste.
- Sin hacer: Doppler (un `PannerNode` no lo da; haría falta un cambio de tono por emisor), `VoiceWorld` para Poolrooms y parking, cifrado (entrega 3).
