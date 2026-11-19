// Agua de las Poolrooms (client/src/game/pool.ts, PoolWater): ondas analiticas, caustica falsa, color por profundidad y el reflejo planar del Reflector.
// Uniformes (desde el vec4 1): [uTime, uDeep, uCeil, _], [uCam.xyz, _], [uHalf.xy, _, _], uRip[20] (vec4 4..23), textureMatrix (vec4 24..27, columnas).
// textura: t0 = tDiffuse.

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vW: vec3<f32>,
    @location(1) vUv: vec4<f32>,
    @location(2) fogDepth: f32,
    @location(3) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let w = modelOf(di) * vec4<f32>(position, 1.0);
    let tm = mat4x4<f32>(ub(di, 24u), ub(di, 25u), ub(di, 26u), ub(di, 27u));
    let mv = g.view * w;
    var out: VOut;
    out.vW = w.xyz;
    out.vUv = tm * vec4<f32>(position, 1.0);
    out.pos = clip_of(mv);
    out.fogDepth = -mv.z;
    out.di = di;
    return out;
}

// gradiente de un campo de ondas: suma de senos con direcciones fijas
fn waves(p: vec2<f32>, t: f32) -> vec2<f32> {
    var gr = vec2<f32>(0.0);
    gr += vec2<f32>(0.8, 0.6) * 0.040 * 3.1 * cos(dot(p, vec2<f32>(0.8, 0.6)) * 3.1 + t * 1.60);
    gr += vec2<f32>(-0.5, 0.86) * 0.030 * 4.7 * cos(dot(p, vec2<f32>(-0.5, 0.86)) * 4.7 - t * 1.90);
    gr += vec2<f32>(0.97, -0.24) * 0.018 * 7.3 * cos(dot(p, vec2<f32>(0.97, -0.24)) * 7.3 + t * 2.50);
    gr += vec2<f32>(-0.3, -0.95) * 0.010 * 11.0 * cos(dot(p, vec2<f32>(-0.3, -0.95)) * 11.0 - t * 3.20);
    return gr;
}

fn ripples(p: vec2<f32>, t: f32, di: u32) -> vec2<f32> {
    var gr = vec2<f32>(0.0);
    for (var i = 0u; i < 20u; i = i + 1u) {
        let r = ub(di, 4u + i);
        let age = t - r.z;
        if (r.w <= 0.0 || age < 0.0 || age > 6.0) {
            continue;
        }
        let d = p - r.xy;
        let dl = length(d) + 1e-4;
        let u = dl - 1.7 * age;
        let env = exp(-age * 0.75) * exp(-(u * u)) * r.w;
        let f = env * (18.0 * cos(18.0 * u) + sin(18.0 * u) * (-2.0 * 1.0 * u)) * 0.028;
        gr += f * d / dl;
    }
    return gr;
}

fn hash(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }

// caustica: dos capas de lineas de celda desplazadas
fn caustic(p: vec2<f32>, t: f32) -> f32 {
    var c = 0.0;
    for (var k = 0; k < 2; k = k + 1) {
        var q = p * (1.7 + f32(k) * 1.1) + vec2<f32>(t * 0.15, -t * 0.11) * (1.0 + f32(k));
        q += 0.35 * vec2<f32>(sin(q.y * 1.7 + t), cos(q.x * 1.9 - t * 0.8));
        let f = abs(fract(q) - 0.5);
        c += pow(1.0 - 2.0 * min(f.x, f.y), 14.0);
    }
    return c * 0.5;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let di = in.di;
    let u1 = ub(di, 1u);
    let uTime = u1.x;
    let uDeep = u1.y;
    let uCam = ub(di, 2u).xyz;
    let uHalf = ub(di, 3u).xy;
    let vW = in.vW;
    let V = normalize(uCam - vW);
    let gr = waves(vW.xz, uTime) + waves(vW.xz * 1.9 + 3.0 + vec2<f32>(0.35, 0.2) * uTime, -uTime * 0.8) * 0.8 + ripples(vW.xz, uTime, di);
    let N = normalize(vec3<f32>(-gr.x, 1.0, -gr.y));
    let cosv = max(dot(N, V), 0.0);
    let fres = 0.2 + 0.8 * pow(1.0 - cosv, 4.0);
    let dir = refract(-V, N, 0.75);
    let depth = uDeep + 0.0;
    let fp = vW.xz + dir.xz / max(-dir.y, 0.2) * depth;
    let cs = caustic(fp, uTime);
    let tile = vec3<f32>(0.74, 0.90, 0.76) * (0.82 + 0.18 * step(0.5, hash(floor(fp * 2.0))));
    let under = tile * (0.5 + 1.3 * cs);
    let k = 1.0 - exp(-depth * 0.9);
    let body = mix(under, vec3<f32>(0.06, 0.42, 0.27), k * 0.75);
    let e = uHalf - abs(vW.xz);
    let foam = sstep(0.35, 0.0, min(e.x, e.y)) * (0.5 + 0.5 * sin(uTime * 1.3 + vW.x * 3.0 + vW.z * 2.0));
    // reflejo planar (texture2DProj): la division por w va a mano
    let pq = vec4<f32>(in.vUv.xy + N.xz * 0.09 * in.vUv.w, in.vUv.zw);
    let refl = textureSample(t0, s0, pq.xy / pq.w).rgb;
    var col = mix(body, refl, clamp(fres * 1.05, 0.0, 0.95)) + foam * 0.25;
    col = fog_out(col, in.fogDepth, ub(di, 0u).x);
    return vec4<f32>(col, 1.0);
}
