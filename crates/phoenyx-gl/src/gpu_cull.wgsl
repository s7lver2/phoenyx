// Culling y eleccion de LOD en GPU para las mallas instanciadas marcadas (idea de Phoenix; el dibujo lo hace el sombreado legacy de Phoenyx).
// Una invocacion por instancia: frustum de la camara, LOD por error proyectado en pixeles, y la suma atomica a los argumentos indirectos.

struct Globals {
    view: mat4x4<f32>,
    proj: mat4x4<f32>,
    cam: vec4<f32>,
    p0: vec4<f32>,
    fogc: vec4<f32>,
    clear: vec4<f32>,
    dim: vec4<f32>,
    amb: vec4<f32>,
    pad0: vec4<f32>,
    pad1: vec4<f32>,
};

struct Obj {
    model: mat4x4<f32>,
    n0: vec4<f32>,
    n1: vec4<f32>,
    n2: vec4<f32>,
    pad: vec4<f32>,
};

// un grupo = una malla instanciada con sus LOD (hasta 4)
struct Group {
    a: vec4<u32>,   // x primera matriz en la reserva, y numero de instancias, z objeto, w numero de LOD
    b: vec4<f32>,   // x radio local, yzw centro local
    err: vec4<f32>, // error (en unidades del modelo) de cada LOD; el LOD 0 vale 0
    vis: vec4<u32>, // base de la lista de visibles de cada LOD
    slot: vec4<u32>, // plaza de los argumentos indirectos de cada LOD
};

struct Params {
    tau: f32,      // tolerancia de error en pixeles
    height: f32,   // alto del viewport en pixeles
    min_px: f32,   // diametro minimo en pixeles para dibujar
    pad: f32,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<storage, read> objects: array<Obj>;
@group(0) @binding(2) var<storage, read> inst_mats: array<mat4x4<f32>>;
@group(0) @binding(3) var<storage, read> groups: array<Group>;
@group(0) @binding(4) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> vis: array<u32>;
@group(0) @binding(6) var<uniform> prm: Params;

fn row(m: mat4x4<f32>, k: u32) -> vec4<f32> {
    return vec4<f32>(m[0][k], m[1][k], m[2][k], m[3][k]);
}

fn outside(pl: vec4<f32>, vp: vec3<f32>, r: f32) -> bool {
    return (dot(pl.xyz, vp) + pl.w) / length(pl.xyz) < -r;
}

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) id: vec3<u32>, @builtin(workgroup_id) wg: vec3<u32>) {
    let gr = groups[wg.y];
    let i = id.x;
    if (i >= gr.a.y) {
        return;
    }
    let m = objects[gr.a.z].model * inst_mats[gr.a.x + i];
    let c = (m * vec4<f32>(gr.b.yzw, 1.0)).xyz;
    let sx = length(m[0].xyz);
    let sy = length(m[1].xyz);
    let sz = length(m[2].xyz);
    let sc = max(sx, max(sy, sz));
    let r = gr.b.x * sc;
    let vp = (g.view * vec4<f32>(c, 1.0)).xyz;
    // frustum: los seis planos salen de las filas de la proyeccion (la z de clip de three va en [-w, w])
    let p = g.proj;
    let r0 = row(p, 0u);
    let r1 = row(p, 1u);
    let r2 = row(p, 2u);
    let r3 = row(p, 3u);
    if (outside(r3 + r0, vp, r) || outside(r3 - r0, vp, r) || outside(r3 + r1, vp, r) || outside(r3 - r1, vp, r) || outside(r3 + r2, vp, r) || outside(r3 - r2, vp, r)) {
        return;
    }
    let dist = max(length(vp), 0.0001);
    // pixeles por unidad a esa distancia: proj[1][1] * alto / 2 / distancia
    let ppu = p[1][1] * prm.height * 0.5 / dist;
    // demasiado pequena para verse
    if (r * 2.0 * ppu < prm.min_px) {
        return;
    }
    // el LOD mas grueso cuyo error proyectado cabe en la tolerancia
    var lod = 0u;
    let n = gr.a.w;
    for (var l = n - 1u; l > 0u; l = l - 1u) {
        let e = gr.err[l] * sc * ppu;
        if (e <= prm.tau) {
            lod = l;
            break;
        }
    }
    let s = atomicAdd(&args[gr.slot[lod] * 5u + 1u], 1u);
    vis[gr.vis[lod] + s] = i;
}
