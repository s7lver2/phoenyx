// Shaders de client/src/game/parking-atmosphere.ts (GLSL copiado tal cual) asociados a user/parking_fog.wgsl (ids 2 y 3, segun la
// calidad: 4 o 10 pasos de marcha) y user/parking_shaft.wgsl (id 4).
// @ts-nocheck
import { registerUserShader } from './index';

export const vertex = `varying vec3 vWorld; varying vec3 vNormal; void main(){vNormal=normalize(mat3(modelMatrix)*normal);vWorld=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);}`;
export const fogFragment = (low: boolean) => `
        varying vec3 vWorld; uniform float uTime,uPower; uniform vec3 uMin,uMax;
        float density(vec3 p){vec3 q=p*.9+vec3(uTime*.035,0.,uTime*.017);float n=sin(q.x+sin(q.z*1.7))*sin(q.z*.7+sin(q.y*2.1))+sin(q.x*2.3+q.z*1.3+uTime*.06)*.3;return (.65+n*.22)*exp(-(p.y-uMin.y)*1.35);}
        void main(){bool inside=all(greaterThanEqual(cameraPosition,uMin))&&all(lessThanEqual(cameraPosition,uMax));if(gl_FrontFacing==inside)discard;vec3 rd=normalize(vWorld-cameraPosition);vec3 inv=1./rd;vec3 a=(uMin-cameraPosition)*inv,b=(uMax-cameraPosition)*inv;vec3 mn=min(a,b),mx=max(a,b);float near=max(max(mn.x,mn.y),mn.z),far=min(min(mx.x,mx.y),mx.z);near=max(0.,near);if(far<=near)discard;float stepSize=(far-near)/${low?'4.':'10.'};float optical=0.;for(int j=0;j<${low?4:10};j++){vec3 p=cameraPosition+rd*(near+(float(j)+.5)*stepSize);float edge=smoothstep(0.,.6,min(min(p.x-uMin.x,uMax.x-p.x),min(p.z-uMin.z,uMax.z-p.z)));optical+=density(p)*edge*stepSize;}float alpha=(1.-exp(-optical*.12))*(1.-smoothstep(6.,18.,distance(cameraPosition,vWorld)));gl_FragColor=vec4(vec3(.14,.18,.15)+vec3(.02)*uPower,min(alpha,.25));}`;
export const shaftFragment = `varying vec3 vWorld;varying vec3 vNormal;uniform float uTime,uBase,uPower;void main(){float h=clamp((vWorld.y-uBase)/3.1,0.,1.);float edge=smoothstep(0.,.45,abs(dot(normalize(vNormal),normalize(cameraPosition-vWorld))));float pulse=uPower;float alpha=.012*sin(h*3.14159)*edge*pulse*(1.-smoothstep(3.,15.,distance(cameraPosition,vWorld)));gl_FragColor=vec4(.61,.67,.48,alpha);}`;

// volumen: [uTime, uPower, _, _], [uMin.xyz, _], [uMax.xyz, _]
const packFog = (m) => {
  const u = m.uniforms;
  return [u.uTime.value, u.uPower.value, 0, 0, u.uMin.value.x, u.uMin.value.y, u.uMin.value.z, 0, u.uMax.value.x, u.uMax.value.y, u.uMax.value.z, 0];
};
registerUserShader(vertex, fogFragment(true), { id: 2, pack: packFog });
registerUserShader(vertex, fogFragment(false), { id: 3, pack: packFog });
// haz: [uTime, uBase, uPower, _]
registerUserShader(vertex, shaftFragment, { id: 4, pack: (m) => [m.uniforms.uTime.value, m.uniforms.uBase.value, m.uniforms.uPower.value, 0] });
