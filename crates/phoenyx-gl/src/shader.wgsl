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
    let alpha = m.color.a;
    // derivadas antes de cualquier rama (control uniforme)
    let nUn = normalize(in.vnormal);
    let ddx = dpdx(nUn);
    let ddy = dpdy(nUn);
    // color_fragment: diffuseColor.rgb *= vColor (vertexColors)
    let diffuse = select(m.color.rgb, m.color.rgb * in.color, m.misc.w > 0.5);
    var rgb = diffuse;   // MeshBasicMaterial: outgoingLight = diffuse

    if (m.misc.y > 0.5) {
        // ---- MeshStandardMaterial: meshphysical.glsl.js sin sheen, clearcoat, iridiscencia ni transmision ----
        var normal = nUn;
        if ((dr.w & 64u) != 0u) {   // DOUBLE_SIDED
            normal = normal * select(-1.0, 1.0, frontFacing);
        }
        let metalnessFactor = m.misc.x;
        let roughnessFactor = m.emissive.a;
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
        rgb = totalDiffuse + directSpecular + m.emissive.rgb;
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
    return vec4<f32>(rgb, alpha);
}
