// Reflejo del pulido bajo la alfombra de world.ts (client/src/game/world.ts): el mismo GLSL, el mismo Reflector y el mismo ajuste del plano lejano.
export function makeCarpetReflector(THREE, Reflector) {
  const shader = {
    name: 'SuitesFloor',
    uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null } },
    vertexShader: `uniform mat4 textureMatrix; varying vec4 vUv; void main() { vUv = textureMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D tDiffuse; varying vec4 vUv; void main() { vec4 b = texture2DProj(tDiffuse, vUv); gl_FragColor = vec4(b.rgb, 0.22);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`,
  };
  const rf = new Reflector(new THREE.PlaneGeometry(10, 3), { textureWidth: 256, textureHeight: 256, clipBias: 0.003, shader });
  const paint = rf.onBeforeRender;
  rf.onBeforeRender = function (...a) {
    const cam = a[2], far = cam.far;
    (cam.far = 14), cam.updateProjectionMatrix();
    paint.apply(this, a);
    (cam.far = far), cam.updateProjectionMatrix();
  };
  const m = rf.material;
  m.transparent = true;
  m.depthWrite = false;
  rf.rotation.x = -Math.PI / 2;
  rf.position.set(0, 0.003, 0);
  rf.renderOrder = 1;
  return rf;
}
