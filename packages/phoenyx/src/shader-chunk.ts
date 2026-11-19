// `THREE.ShaderChunk` reducido: solo el chunk que el juego lee como texto (parche poolTile de poolmap.ts). Lo demas del registro de chunks
// de three no se usa: el sombreado vive en crates/phoenyx-gl/src/shader.wgsl.
// @ts-nocheck
import lights_fragment_begin from './three/renderers/shaders/ShaderChunk/lights_fragment_begin.glsl.js';

export const ShaderChunk = { lights_fragment_begin };
