// Haces de client/src/game/remote.ts (mismo GLSL y mismos conos): nucleo estrecho y penumbra ancha.
export function makeRemoteBeams(THREE, { t, on }) {
  const cone = (r) => new THREE.ConeGeometry(r, 6, 20, 1, true).translate(0, -3, 0).rotateX(Math.PI / 2);
  const BEAM = [cone(1.5), cone(0.55)];
  const beamMat = (k) =>
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uK: { value: k }, uT: { value: 0 }, uOn: { value: 1 } },
      vertexShader: `varying float vT; varying vec3 vN; varying vec3 vV;
      void main() { vT = -position.z / 6.0; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uK; uniform float uT; uniform float uOn; varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float along = pow(1.0 - vT, 1.7) * smoothstep(0.0, 0.06, vT);
        float dust = 0.88 + 0.12 * sin(vT * 38.0 - uT * 1.7) * sin(vT * 11.0 + uT * 0.9);
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.74) * uK * edge * along * dust * uOn, 1.0);
      }`,
    });
  const mats = [beamMat(0.07), beamMat(0.16)];
  const group = new THREE.Group();
  BEAM.forEach((g, i) => { const m = new THREE.Mesh(g, mats[i]); group.add(m); });
  for (const m of mats) { m.uniforms.uT.value = t; m.uniforms.uOn.value = on; }
  return group;
}
