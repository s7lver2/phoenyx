// Materiales de client/src/game/parking-atmosphere.ts (mismo GLSL y mismos parametros): volumen de niebla y haz.
export function makeParkingAtmosphere(THREE, low, a) {
  const vertex = `varying vec3 vWorld; varying vec3 vNormal; void main(){vNormal=normalize(mat3(modelMatrix)*normal);vWorld=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);}`;
  const group = new THREE.Group();
  const fog = new THREE.ShaderMaterial({ uniforms:{uTime:{value:0},uPower:{value:1},uMin:{value:new THREE.Vector3()},uMax:{value:new THREE.Vector3()}}, vertexShader:vertex, fragmentShader:`
        varying vec3 vWorld; uniform float uTime,uPower; uniform vec3 uMin,uMax;
        float density(vec3 p){vec3 q=p*.9+vec3(uTime*.035,0.,uTime*.017);float n=sin(q.x+sin(q.z*1.7))*sin(q.z*.7+sin(q.y*2.1))+sin(q.x*2.3+q.z*1.3+uTime*.06)*.3;return (.65+n*.22)*exp(-(p.y-uMin.y)*1.35);}
        void main(){bool inside=all(greaterThanEqual(cameraPosition,uMin))&&all(lessThanEqual(cameraPosition,uMax));if(gl_FrontFacing==inside)discard;vec3 rd=normalize(vWorld-cameraPosition);vec3 inv=1./rd;vec3 a=(uMin-cameraPosition)*inv,b=(uMax-cameraPosition)*inv;vec3 mn=min(a,b),mx=max(a,b);float near=max(max(mn.x,mn.y),mn.z),far=min(min(mx.x,mx.y),mx.z);near=max(0.,near);if(far<=near)discard;float stepSize=(far-near)/${low?'4.':'10.'};float optical=0.;for(int j=0;j<${low?4:10};j++){vec3 p=cameraPosition+rd*(near+(float(j)+.5)*stepSize);float edge=smoothstep(0.,.6,min(min(p.x-uMin.x,uMax.x-p.x),min(p.z-uMin.z,uMax.z-p.z)));optical+=density(p)*edge*stepSize;}float alpha=(1.-exp(-optical*.12))*(1.-smoothstep(6.,18.,distance(cameraPosition,vWorld)));gl_FragColor=vec4(vec3(.14,.18,.15)+vec3(.02)*uPower,min(alpha,.25));}`,
    transparent:true,depthTest:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false });
  const shaft = new THREE.ShaderMaterial({uniforms:{uTime:{value:0},uBase:{value:0},uPower:{value:1}},vertexShader:vertex,fragmentShader:`varying vec3 vWorld;varying vec3 vNormal;uniform float uTime,uBase,uPower;void main(){float h=clamp((vWorld.y-uBase)/3.1,0.,1.);float edge=smoothstep(0.,.45,abs(dot(normalize(vNormal),normalize(cameraPosition-vWorld))));float pulse=uPower;float alpha=.012*sin(h*3.14159)*edge*pulse*(1.-smoothstep(3.,15.,distance(cameraPosition,vWorld)));gl_FragColor=vec4(.61,.67,.48,alpha);}`,transparent:true,depthTest:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4.4,2.9,4.4), fog); mesh.renderOrder = 4; group.add(mesh);
  const beam = new THREE.Mesh(new THREE.ConeGeometry(1.35,3.1,24,1,true), shaft); beam.renderOrder = 3; group.add(beam);
  // como ParkingAtmosphere.update: `a` = { x, y, z, time, power }
  mesh.position.set(a.x, a.y + 1.53, a.z);
  fog.uniforms.uTime.value = a.time; fog.uniforms.uPower.value = a.power;
  fog.uniforms.uMin.value.set(a.x - 2.2, a.y + .08, a.z - 2.2); fog.uniforms.uMax.value.set(a.x + 2.2, a.y + 2.98, a.z + 2.2);
  beam.position.set(a.x, a.y + 1.78, a.z);
  shaft.uniforms.uBase.value = a.y + .23; shaft.uniforms.uTime.value = a.time; shaft.uniforms.uPower.value = a.power;
  return group;
}
