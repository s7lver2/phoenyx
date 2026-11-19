// cube_uv_reflection_fragment de three 0.160.1 (ENVMAP_TYPE_CUBE_UV): la textura PMREM en formato CubeUV, compartida por
// shader.wgsl (reflejos y luz difusa del entorno) y post.wgsl (el desenfoque de PMREMGenerator).
// Los #define CUBEUV_TEXEL_WIDTH / HEIGHT / MAX_MIP salen del tamano de la propia textura: ancho = 3 * max(cubo, 112),
// alto = 4 * cubo, MAX_MIP = log2(cubo).

const cubeUV_minMipLevel = 4.0;
const cubeUV_minTileSize = 16.0;

fn cuv_getFace(direction: vec3<f32>) -> f32 {
    let a = abs(direction);
    var face = -1.0;
    if (a.x > a.z) {
        if (a.x > a.y) {
            face = select(3.0, 0.0, direction.x > 0.0);
        } else {
            face = select(4.0, 1.0, direction.y > 0.0);
        }
    } else {
        if (a.z > a.y) {
            face = select(5.0, 2.0, direction.z > 0.0);
        } else {
            face = select(4.0, 1.0, direction.y > 0.0);
        }
    }
    return face;
}

// sistema de coordenadas RH; convencion de caras de PMREM
fn cuv_getUV(direction: vec3<f32>, face: f32) -> vec2<f32> {
    var uv: vec2<f32>;
    if (face == 0.0) {
        uv = vec2<f32>(direction.z, direction.y) / abs(direction.x);
    } else if (face == 1.0) {
        uv = vec2<f32>(-direction.x, -direction.z) / abs(direction.y);
    } else if (face == 2.0) {
        uv = vec2<f32>(-direction.x, direction.y) / abs(direction.z);
    } else if (face == 3.0) {
        uv = vec2<f32>(-direction.z, direction.y) / abs(direction.x);
    } else if (face == 4.0) {
        uv = vec2<f32>(-direction.x, direction.z) / abs(direction.y);
    } else {
        uv = vec2<f32>(direction.x, direction.y) / abs(direction.z);
    }
    return 0.5 * (uv + 1.0);
}

fn cuv_bilinear(tex: texture_2d<f32>, smp: sampler, direction: vec3<f32>, mipIn: f32) -> vec3<f32> {
    var face = cuv_getFace(direction);
    let filterInt = max(cubeUV_minMipLevel - mipIn, 0.0);
    let mipInt = max(mipIn, cubeUV_minMipLevel);
    let faceSize = exp2(mipInt);
    var uv = cuv_getUV(direction, face) * (faceSize - 2.0) + 1.0;
    if (face > 2.0) {
        uv.y += faceSize;
        face -= 3.0;
    }
    uv.x += face * faceSize;
    uv.x += filterInt * 3.0 * cubeUV_minTileSize;
    let dims = vec2<f32>(textureDimensions(tex));
    let maxMip = log2(dims.y / 4.0);
    uv.y += 4.0 * (exp2(maxMip) - faceSize);
    uv = uv / dims;
    // texture2DGradEXT con gradientes 0: nivel 0, sin filtrado anisotropico
    return textureSampleLevel(tex, smp, uv, 0.0).rgb;
}

fn cuv_roughnessToMip(roughness: f32) -> f32 {
    var mip = 0.0;
    if (roughness >= 0.8) {
        mip = (1.0 - roughness) * (-1.0 - -2.0) / (1.0 - 0.8) + -2.0;
    } else if (roughness >= 0.4) {
        mip = (0.8 - roughness) * (2.0 - -1.0) / (0.8 - 0.4) + -1.0;
    } else if (roughness >= 0.305) {
        mip = (0.4 - roughness) * (3.0 - 2.0) / (0.4 - 0.305) + 2.0;
    } else if (roughness >= 0.21) {
        mip = (0.305 - roughness) * (4.0 - 3.0) / (0.305 - 0.21) + 3.0;
    } else {
        mip = -2.0 * log2(1.16 * roughness);
    }
    return mip;
}

fn cuv_textureCubeUV(tex: texture_2d<f32>, smp: sampler, sampleDir: vec3<f32>, roughness: f32) -> vec3<f32> {
    let dims = vec2<f32>(textureDimensions(tex));
    let maxMip = log2(dims.y / 4.0);
    let mip = clamp(cuv_roughnessToMip(roughness), -2.0, maxMip);
    let mipF = fract(mip);
    let mipInt = floor(mip);
    let color0 = cuv_bilinear(tex, smp, sampleDir, mipInt);
    if (mipF == 0.0) {
        return color0;
    }
    let color1 = cuv_bilinear(tex, smp, sampleDir, mipInt + 1.0);
    return mix(color0, color1, mipF);
}
