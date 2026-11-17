// Sombreado de three 0.160.1 portado a WGSL (MeshBasicMaterial y MeshStandardMaterial). Cada bloque nombra el chunk de three que replica.
// Orden de salida igual que en three: luces -> tonemapping_fragment -> colorspace_fragment -> fog_fragment.

struct Globals {
    view: mat4x4<f32>,
    proj: mat4x4<f32>,
    cam: vec4<f32>,      // xyz posicion de la camara, w exposicion del tone mapping
    p0: vec4<f32>,       // x modo de tone mapping (0 ninguno, 1 ACES), y modo de niebla (0 ninguna, 1 lineal, 2 exp2), z near, w far
    fogc: vec4<f32>,     // rgb color de la niebla (en el espacio de salida, como refreshFogUniforms), w densidad
    clear: vec4<f32>,    // color de fondo (lo usa el anfitrion Rust)
    dim: vec4<f32>,      // x ancho, y alto, z numero de luces
    amb: vec4<f32>,      // rgb luz ambiente (suma de AmbientLight * intensidad)
    pad0: vec4<f32>,
    pad1: vec4<f32>,
};

struct Obj {
    model: mat4x4<f32>,
    n0: vec4<f32>,       // matriz normal (vista) por columnas
    n1: vec4<f32>,
    n2: vec4<f32>,
    pad: vec4<f32>,
};

struct Mat {
    color: vec4<f32>,    // rgb color lineal, a opacidad
    emissive: vec4<f32>, // rgb emisivo * intensidad, a rugosidad
    misc: vec4<f32>,     // x metalicidad, y tipo (0 basic, 1 standard), z niebla (1 si), w vertexColors (1 si)
    tp: vec4<f32>,       // x alphaTest, yz normalScale, w bumpScale
    maps: vec4<f32>,     // x mascara de mapas: 1 map, 2 normalMap, 4 roughnessMap, 8 emissiveMap, 16 bumpMap
    uv: array<vec4<f32>, 10>, // por mapa (mismo orden): (a, b, c, d) y (tx, ty, 0, 0) de la matriz de uv de la textura
    pad: vec4<f32>,
};

struct Light {
    a: vec4<f32>,        // x tipo (0 direccional, 1 puntual), yzw color * intensidad
    b: vec4<f32>,        // xyz posicion (vista), w distancia de corte
    c: vec4<f32>,        // x decaimiento, yzw direccion hacia la luz (vista)
    d: vec4<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<storage, read> objects: array<Obj>;
@group(0) @binding(2) var<storage, read> materials: array<Mat>;
@group(0) @binding(3) var<storage, read> lights: array<Light>;
@group(0) @binding(4) var<storage, read> draws: array<vec4<u32>>;

@group(1) @binding(0) var tex_map: texture_2d<f32>;
@group(1) @binding(1) var tex_normal: texture_2d<f32>;
@group(1) @binding(2) var tex_rough: texture_2d<f32>;
@group(1) @binding(3) var tex_emis: texture_2d<f32>;
@group(1) @binding(4) var tex_bump: texture_2d<f32>;
@group(1) @binding(5) var smp_map: sampler;
@group(1) @binding(6) var smp_normal: sampler;
@group(1) @binding(7) var smp_rough: sampler;
@group(1) @binding(8) var smp_emis: sampler;
@group(1) @binding(9) var smp_bump: sampler;

/// uv de un mapa: matriz de uv de la textura (texture.matrix) aplicada a las uv interpoladas.
fn uvT(m: Mat, k: u32, uv: vec2<f32>) -> vec2<f32> {
    let a = m.uv[k * 2u];
    let b = m.uv[k * 2u + 1u];
    return vec2<f32>(a.x * uv.x + a.z * uv.y + b.x, a.y * uv.x + a.w * uv.y + b.y);
}

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vpos: vec3<f32>,
    @location(1) vnormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) @interpolate(flat) di: u32,
    @location(4) color: vec3<f32>,
};

@vertex
fn vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let d = draws[ii * 2u];
    let o = objects[d.y];
    let mv = g.view * o.model;
    let vp = mv * vec4<f32>(position, 1.0);
    var clip = g.proj * vp;
    // three (WebGL) usa z de clip en [-w, w]; WebGPU, en [0, w]
    clip.z = (clip.z + clip.w) * 0.5;
    var out: VOut;
    out.pos = clip;
    out.vpos = vp.xyz;
    // FLIP_SIDED (material BackSide): three invierte la normal en el vertex shader
    let flip = select(1.0, -1.0, (d.w & 32u) != 0u);
    out.vnormal = mat3x3<f32>(o.n0.xyz, o.n1.xyz, o.n2.xyz) * normal * flip;
    out.uv = uv;
    out.di = ii;
    out.color = color;
    return out;
}

// ---- tonemapping_pars_fragment: ACESFilmicToneMapping ----
const ACESInputMat = mat3x3<f32>(vec3<f32>(0.59719, 0.07600, 0.02840), vec3<f32>(0.35458, 0.90834, 0.13383), vec3<f32>(0.04823, 0.01566, 0.83777));
const ACESOutputMat = mat3x3<f32>(vec3<f32>(1.60475, -0.10208, -0.00327), vec3<f32>(-0.53108, 1.10813, -0.07276), vec3<f32>(-0.07367, -0.00605, 1.07602));

fn RRTAndODTFit(v: vec3<f32>) -> vec3<f32> {
    let a = v * (v + 0.0245786) - 0.000090537;
    let b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
}

fn ACESFilmicToneMapping(c: vec3<f32>) -> vec3<f32> {
    var color = c * (g.cam.w / 0.6);
    color = ACESInputMat * color;
    color = RRTAndODTFit(color);
    color = ACESOutputMat * color;
    return saturate(color);
}

// ---- colorspace_pars_fragment: sRGBTransferOETF ----
fn sRGBTransferOETF(v: vec3<f32>) -> vec3<f32> {
    return select(pow(v, vec3<f32>(0.41666)) * 1.055 - vec3<f32>(0.055), v * 12.92, v <= vec3<f32>(0.0031308));
}


// ---- common.glsl / bsdfs.glsl ----
const RECIPROCAL_PI = 0.3183098861837907;
const EPSILON = 1e-6;

fn pow2(x: f32) -> f32 { return x * x; }
fn pow4(x: f32) -> f32 { let x2 = x * x; return x2 * x2; }

// lights_pars_begin: getDistanceAttenuation
fn getDistanceAttenuation(lightDistance: f32, cutoffDistance: f32, decayExponent: f32) -> f32 {
    var distanceFalloff = 1.0 / max(pow(lightDistance, decayExponent), 0.01);
    if (cutoffDistance > 0.0) {
        distanceFalloff *= pow2(saturate(1.0 - pow4(lightDistance / cutoffDistance)));
    }
    return distanceFalloff;
}

fn F_Schlick(f0: vec3<f32>, f90: f32, dotVH: f32) -> vec3<f32> {
    let fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
    return f0 * (1.0 - fresnel) + (f90 * fresnel);
}

fn V_GGX_SmithCorrelated(alpha: f32, dotNL: f32, dotNV: f32) -> f32 {
    let a2 = pow2(alpha);
    let gv = dotNL * sqrt(a2 + (1.0 - a2) * pow2(dotNV));
    let gl = dotNV * sqrt(a2 + (1.0 - a2) * pow2(dotNL));
    return 0.5 / max(gv + gl, EPSILON);
}

fn D_GGX(alpha: f32, dotNH: f32) -> f32 {
    let a2 = pow2(alpha);
    let denom = pow2(dotNH) * (a2 - 1.0) + 1.0;
    return RECIPROCAL_PI * a2 / pow2(denom);
}

struct PhysMat {
    diffuseColor: vec3<f32>,
    roughness: f32,
    specularColor: vec3<f32>,
    specularF90: f32,
};

// BRDF_GGX
fn BRDF_GGX(lightDir: vec3<f32>, viewDir: vec3<f32>, normal: vec3<f32>, material: PhysMat) -> vec3<f32> {
    let f0 = material.specularColor;
    let f90 = material.specularF90;
    let alpha = pow2(material.roughness);
    let halfDir = normalize(lightDir + viewDir);
    let dotNL = saturate(dot(normal, lightDir));
    let dotNV = saturate(dot(normal, viewDir));
    let dotNH = saturate(dot(normal, halfDir));
    let dotVH = saturate(dot(viewDir, halfDir));
    let F = F_Schlick(f0, f90, dotVH);
    let V = V_GGX_SmithCorrelated(alpha, dotNL, dotNV);
    let D = D_GGX(alpha, dotNH);
    return F * (V * D);
}

fn BRDF_Lambert(diffuseColor: vec3<f32>) -> vec3<f32> {
    return RECIPROCAL_PI * diffuseColor;
}

@fragment
fn fs(in: VOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
    let dr = draws[in.di * 2u];
    let m = materials[dr.z];
    // derivadas antes de cualquier rama (control uniforme)
    let nUn = normalize(in.vnormal);
    let ddx = dpdx(nUn);
    let ddy = dpdy(nUn);
    // texturas: todas se muestrean sin ramas (control uniforme); la mascara decide cuales cuentan
    let maps = u32(m.maps.x);
    let sMap = textureSample(tex_map, smp_map, uvT(m, 0u, in.uv));
    let sRough = textureSample(tex_rough, smp_rough, uvT(m, 2u, in.uv));
    let sEmis = textureSample(tex_emis, smp_emis, uvT(m, 3u, in.uv));
    // normal_fragment_maps / bumpmap_pars_fragment / normalmap_pars_fragment: derivadas y muestras fuera de cualquier rama
    let backSgn = select(1.0, -1.0, (dr.w & 32u) != 0u);   // three niega normalScale y bumpScale con BackSide
    let uvN = uvT(m, 1u, in.uv);
    let uvB = uvT(m, 4u, in.uv);
    let q0 = dpdx(in.vpos);
    // WebGPU tiene la y de pantalla hacia abajo y GL hacia arriba: dFdy de GLSL = -dpdy
    let q1 = -dpdy(in.vpos);
    let stN0 = dpdx(uvN);
    let stN1 = -dpdy(uvN);
    let dSTdx = dpdx(uvB);
    let dSTdy = -dpdy(uvB);
    let sNormal = textureSample(tex_normal, smp_normal, uvN);
    let bumpScale = m.tp.w * backSgn;
    let Hll = bumpScale * textureSample(tex_bump, smp_bump, uvB).x;
    let dBx = bumpScale * textureSample(tex_bump, smp_bump, uvB + dSTdx).x - Hll;
    let dBy = bumpScale * textureSample(tex_bump, smp_bump, uvB + dSTdy).x - Hll;
    // map_fragment: diffuseColor *= sampledDiffuseColor; color_fragment: diffuseColor.rgb *= vColor
    var diffuse = m.color.rgb;
    var diffuseA = m.color.a;
    if ((maps & 1u) != 0u) {
        diffuse = diffuse * sMap.rgb;
        diffuseA = diffuseA * sMap.a;
    }
    if (m.misc.w > 0.5) {
        diffuse = diffuse * in.color;
    }
    // alphatest_fragment
    if (m.tp.x > 0.0 && diffuseA < m.tp.x) {
        discard;
    }
    var rgb = diffuse;   // MeshBasicMaterial: outgoingLight = diffuse

    if (m.misc.y > 0.5) {
        // ---- MeshStandardMaterial: meshphysical.glsl.js sin sheen, clearcoat, iridiscencia ni transmision ----
        // normal_fragment_begin + normal_fragment_maps
        let faceDirection = select(-1.0, 1.0, frontFacing);
        var normal = nUn;
        let doubleSided = (dr.w & 64u) != 0u;
        if (doubleSided) {
            normal = normal * faceDirection;
        }
        if ((maps & 2u) != 0u) {
            // normalmap_pars_fragment: getTangentFrame (sin tangentes precalculadas) y espacio tangente
            let N = normal;
            let q1perp = cross(q1, N);
            let q0perp = cross(N, q0);
            let T = q1perp * stN0.x + q0perp * stN1.x;
            let B = q1perp * stN0.y + q0perp * stN1.y;
            let det = max(dot(T, T), dot(B, B));
            let tscale = select(inverseSqrt(det), 0.0, det == 0.0);
            var tT = T * tscale;
            var tB = B * tscale;
            if (doubleSided) {
                tT = tT * faceDirection;
                tB = tB * faceDirection;
            }
            var mapN = sNormal.xyz * 2.0 - 1.0;
            mapN = vec3<f32>(mapN.xy * (m.tp.yz * backSgn), mapN.z);
            normal = normalize(tT * mapN.x + tB * mapN.y + N * mapN.z);
        } else if ((maps & 16u) != 0u) {
            // perturbNormalArb (Mikkelsen)
            let vSigmaX = normalize(q0);
            let vSigmaY = normalize(q1);
            let vN = normal;
            let R1 = cross(vSigmaY, vN);
            let R2 = cross(vN, vSigmaX);
            let fDet = dot(vSigmaX, R1) * faceDirection;
            let vGrad = sign(fDet) * (dBx * R1 + dBy * R2);
            normal = normalize(abs(fDet) * vN - vGrad);
        }
        let metalnessFactor = m.misc.x;
        let roughnessFactor = m.emissive.a * select(1.0, sRough.g, (maps & 4u) != 0u);
        var material: PhysMat;
        material.diffuseColor = diffuse * (1.0 - metalnessFactor);
        let dxy = max(abs(ddx), abs(ddy));
        let geometryRoughness = max(max(dxy.x, dxy.y), dxy.z);
        material.roughness = max(roughnessFactor, 0.0525);
        material.roughness += geometryRoughness;
        material.roughness = min(material.roughness, 1.0);
        material.specularColor = mix(vec3<f32>(0.04), diffuse, metalnessFactor);
        material.specularF90 = 1.0;

        // lights_fragment_begin
        let geometryPosition = in.vpos;
        // isOrthographic (g.dim.w): la direccion de vista es fija
        let geometryViewDir = select(normalize(-in.vpos), vec3<f32>(0.0, 0.0, 1.0), g.dim.w > 0.5);
        var directDiffuse = vec3<f32>(0.0);
        var directSpecular = vec3<f32>(0.0);
        let nl = u32(g.dim.z);
        for (var i = 0u; i < nl; i = i + 1u) {
            let l = lights[i];
            var dirL: vec3<f32>;
            var col = l.a.yzw;
            if (l.a.x > 0.5) {
                // getPointLightInfo
                let lVector = l.b.xyz - geometryPosition;
                dirL = normalize(lVector);
                let lightDistance = length(lVector);
                col = col * getDistanceAttenuation(lightDistance, l.b.w, l.c.x);
            } else {
                // getDirectionalLightInfo
                dirL = l.c.yzw;
            }
            if (any(col != vec3<f32>(0.0))) {
                // RE_Direct_Physical
                let dotNL = saturate(dot(normal, dirL));
                let irradiance = dotNL * col;
                directSpecular += irradiance * BRDF_GGX(dirL, geometryViewDir, normal, material);
                directDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);
            }
        }
        // RE_IndirectDiffuse_Physical con la luz ambiente
        let indirectDiffuse = g.amb.rgb * BRDF_Lambert(material.diffuseColor);
        let totalDiffuse = directDiffuse + indirectDiffuse;
        let emissive = m.emissive.rgb * select(vec3<f32>(1.0), sEmis.rgb, (maps & 8u) != 0u);
        rgb = totalDiffuse + directSpecular + emissive;
    }

    // tonemapping_fragment
    if (g.p0.x > 0.5) {
        rgb = ACESFilmicToneMapping(rgb);
    }
    // colorspace_fragment (salida sRGB)
    rgb = sRGBTransferOETF(rgb);
    // fog_fragment: se mezcla despues de codificar, con el color de la niebla ya en el espacio de salida
    if (m.misc.z > 0.5 && g.p0.y > 0.5) {
        let depth = -in.vpos.z;
        var f: f32;
        if (g.p0.y < 1.5) {
            f = smoothstep(g.p0.z, g.p0.w, depth);
        } else {
            f = 1.0 - exp(-g.fogc.w * g.fogc.w * depth * depth);
        }
        rgb = mix(rgb, g.fogc.rgb, f);
    }
    // opaque_fragment: los materiales opacos escriben alfa 1
    let outA = select(1.0, diffuseA, (dr.w & 4u) != 0u);
    return vec4<f32>(rgb, outA);
}
