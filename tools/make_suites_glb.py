"""Genera las piezas modulares de un interior tipo Las Suites como .glb (cajas con UV y una textura
base incrustada) para hornearlas con phoenix-bake. Uso: python make_suites_glb.py <salida> <wallpaper.jpg>.
Medidas (m): pared 1.5x2.7x0.12, suelo 1.5x0.2x1.5, techo 1.5x0.2x1.5, puerta 0.9x2.1x0.06, lampara 0.5x0.12x0.5."""
import io, json, struct, sys
import numpy as np
from PIL import Image

out, wall_jpg = sys.argv[1], sys.argv[2]
rng = np.random.default_rng(7)


def noise(n, k):
    a = rng.random((n // k, n // k))
    return np.array(Image.fromarray((a * 255).astype('uint8')).resize((n, n), Image.BICUBIC)) / 255.0


def tex(f):
    img = Image.fromarray(np.clip(f, 0, 255).astype('uint8'), 'RGB')
    b = io.BytesIO(); img.save(b, 'PNG'); return b.getvalue()


n = 512
carpet = np.zeros((n, n, 3))
base = 0.6 * noise(n, 2) + 0.4 * noise(n, 8)
yy, xx = np.mgrid[0:n, 0:n]
motif = (np.sin(xx / n * 6.2832 * 8) * np.sin(yy / n * 6.2832 * 8) > 0.55) * 0.25
for c, v in enumerate((120, 28, 34)):
    carpet[..., c] = v * (0.65 + 0.5 * base + motif)
ceiling = np.stack([np.full((n, n), 232.0)] * 3, -1) * (0.93 + 0.07 * noise(n, 4))[..., None]
grain = 0.5 + 0.5 * np.sin((yy / n * 40) + 6 * noise(n, 16))
wood = np.stack([95 * (0.6 + 0.4 * grain), 60 * (0.6 + 0.4 * grain), 38 * (0.6 + 0.4 * grain)], -1)
lamp = np.stack([np.full((n, n), 255.0), np.full((n, n), 236.0), np.full((n, n), 190.0)], -1)
wall = io.BytesIO(); Image.open(wall_jpg).convert('RGB').resize((1024, 1024)).save(wall, 'PNG')

PIECES = {
    'wall': ((1.5, 2.7, 0.12), wall.getvalue()),
    'floor': ((1.5, 0.2, 1.5), tex(carpet)),
    'ceiling': ((1.5, 0.2, 1.5), tex(ceiling)),
    'door': ((0.9, 2.1, 0.06), tex(wood)),
    'lamp': ((0.5, 0.12, 0.5), tex(lamp)),
}


def box(sx, sy, sz):
    P, N, U, I = [], [], [], []
    faces = [((1, 0, 0), (0, 1, 0), (0, 0, 1)), ((-1, 0, 0), (0, 1, 0), (0, 0, -1)),
             ((0, 1, 0), (0, 0, 1), (1, 0, 0)), ((0, -1, 0), (0, 0, -1), (1, 0, 0)),
             ((0, 0, 1), (0, 1, 0), (-1, 0, 0)), ((0, 0, -1), (0, 1, 0), (1, 0, 0))]
    h = np.array([sx, sy, sz]) / 2
    for nrm, up, rt in faces:
        nrm, up, rt = map(np.array, (nrm, up, rt))
        k = len(P)
        for du, dv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            P.append((nrm * h + rt * h * du + up * h * dv).tolist()); N.append(nrm.tolist())
            U.append([(du + 1) / 2, 1 - (dv + 1) / 2])
        I += [k, k + 1, k + 2, k, k + 2, k + 3]
    return P, N, U, I


def glb(name, size, png):
    P, N, U, I = box(*size)
    pa, na, ua = (np.array(x, dtype='<f4') for x in (P, N, U))
    ia = np.array(I, dtype='<u2')
    parts = [pa.tobytes(), na.tobytes(), ua.tobytes(), ia.tobytes(), png]
    offs, blob = [], b''
    for p in parts:
        offs.append(len(blob)); blob += p + b'\0' * (-len(p) % 4)
    lo, hi = pa.min(0).tolist(), pa.max(0).tolist()
    doc = {
        'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1, 'TEXCOORD_0': 2}, 'indices': 3, 'material': 0}]}],
        'materials': [{'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 0.8}}],
        'textures': [{'source': 0}], 'images': [{'bufferView': 4, 'mimeType': 'image/png'}],
        'accessors': [
            {'bufferView': 0, 'componentType': 5126, 'count': len(P), 'type': 'VEC3', 'min': lo, 'max': hi},
            {'bufferView': 1, 'componentType': 5126, 'count': len(P), 'type': 'VEC3'},
            {'bufferView': 2, 'componentType': 5126, 'count': len(P), 'type': 'VEC2'},
            {'bufferView': 3, 'componentType': 5123, 'count': len(I), 'type': 'SCALAR'}],
        'bufferViews': [{'buffer': 0, 'byteOffset': o, 'byteLength': len(p)} for o, p in zip(offs, parts)],
        'buffers': [{'byteLength': len(blob)}],
    }
    js = json.dumps(doc).encode(); js += b' ' * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(f'{out}/{name}.glb', 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total))
        f.write(struct.pack('<I4s', len(js), b'JSON') + js)
        f.write(struct.pack('<I4s', len(blob), b'BIN\0') + blob)


import os
os.makedirs(out, exist_ok=True)
for k, (s, p) in PIECES.items():
    glb(k, s, p)
print('ok', list(PIECES))
