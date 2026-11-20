/*
 * Cifrado de extremo a extremo de la voz. Los fotogramas de audio ya codificados (Opus) se cifran con AES-GCM antes de salir y se descifran al llegar,
 * con RTCRtpScriptTransform (insertable streams): lo que viaja por la red, por un TURN o por cualquier intermediario es ruido.
 *
 * Claves:
 *   - Cada jugador tiene una clave de emisor (AES-GCM de 128 bits) que cifra su voz; se rota cuando alguien se va (el que se fue no puede seguir oyendo).
 *   - Cada pareja acuerda un secreto con ECDH (P-256, claves efímeras de la sesión) y por él se manda la clave de emisor, envuelta con AES-GCM.
 *   - La señalización la lleva el juego (el servidor ve las claves públicas, no las privadas ni las de emisor).
 *
 * Qué NO hace: autenticar a quien está al otro lado. Si el propio servidor de señalización cambiara las claves públicas por las suyas (un ataque activo),
 * podría oír. Para detectarlo cada pareja tiene un código de seguridad (`safetyCode`) que se puede comparar en voz alta: si coincide, no hay intermediario.
 *
 * Formato de un fotograma cifrado: [1 byte de cabecera de Opus, en claro][id de clave: 1][nonce: 12][texto cifrado + etiqueta de 16].
 * La cabecera y el id van como datos autenticados (AAD): no se pueden cambiar sin que falle el descifrado.
 */

declare class RTCRtpScriptTransform {
  constructor(worker: Worker, options?: unknown);
}

/** El trabajador que cifra y descifra (como texto: se carga con un Blob). */
const WORKER_SRC = /* js */ `
const keys = new Map(); // peer -> Map(id -> CryptoKey)
let own = null;         // { id, key }
const modes = new Map(); // 'encrypt:peer' / 'decrypt:peer' -> true si ya se cifra / descifra (si no, el fotograma pasa tal cual)
const salt = crypto.getRandomValues(new Uint8Array(4));
let ctr = 0;
const HEAD = 1;
onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'mode') return void modes.set(m.op + ':' + m.peer, m.on);
  const key = await crypto.subtle.importKey('raw', m.raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  if (m.t === 'own') own = { id: m.id, key };
  else if (m.t === 'key') {
    let ks = keys.get(m.peer);
    if (!ks) keys.set(m.peer, (ks = new Map()));
    ks.set(m.id, key);
    for (const k of [...ks.keys()]) if (((m.id - k) & 255) > 3) ks.delete(k); // (se guardan las 4 últimas: los fotogramas en vuelo con la clave anterior aún se descifran)
  }
};
self.onrtctransform = (ev) => {
  const t = ev.transformer, op = t.options.operation, peer = t.options.peer;
  t.readable.pipeThrough(new TransformStream({
    async transform(frame, ctl) {
      const d = new Uint8Array(frame.data);
      if (!modes.get(op + ':' + peer)) return ctl.enqueue(frame); // (aún sin cifrar con este jugador: pasa tal cual)
      try {
        if (op === 'encrypt') {
          if (!own || d.length <= HEAD) return; // sin clave aún: no sale nada (mejor silencio que voz en claro)
          const iv = new Uint8Array(12);
          iv.set(salt, 0);
          new DataView(iv.buffer).setUint32(4, Math.floor(ctr / 4294967296));
          new DataView(iv.buffer).setUint32(8, ctr >>> 0);
          ctr++;
          const aad = new Uint8Array([d[0], own.id]);
          const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, own.key, d.subarray(HEAD)));
          const out = new Uint8Array(HEAD + 1 + 12 + ct.length);
          out[0] = d[0]; out[1] = own.id; out.set(iv, 2); out.set(ct, 14);
          frame.data = out.buffer;
        } else {
          if (d.length < HEAD + 1 + 12 + 16) return;
          const key = keys.get(peer)?.get(d[1]);
          if (!key) return; // sin su clave (o sin cifrar): se descarta
          const aad = new Uint8Array([d[0], d[1]]);
          const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.subarray(2, 14), additionalData: aad }, key, d.subarray(14)));
          const out = new Uint8Array(HEAD + pt.length);
          out[0] = d[0]; out.set(pt, HEAD);
          frame.data = out.buffer;
        }
        ctl.enqueue(frame);
      } catch (err) { if (!self.__warned) { self.__warned = 1; postMessage({ op, peer, error: String(err) }); } /* fotograma corrupto o con otra clave: fuera */ }
    },
  })).pipeTo(t.writable);
};
`;

export interface WrappedKey {
  id: number;
  iv: string;
  ct: string;
}

const b64 = (a: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...(a instanceof Uint8Array ? a : new Uint8Array(a))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface PeerKeys {
  wrap: CryptoKey;
  code: string;
}

export class E2ee {
  /** El navegador puede (RTCRtpScriptTransform + WebCrypto). */
  static supported = typeof RTCRtpScriptTransform !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle;
  private worker?: Worker;
  private pair?: CryptoKeyPair;
  private pubJwk?: JsonWebKey;
  private ownId = 0;
  private ownRaw = new Uint8Array(16);
  private peers = new Map<string, PeerKeys>();
  ready: Promise<void>;
  /** El trabajador avisa (una vez) del primer fotograma que no pudo cifrar o descifrar: para depurar. */
  onError?: (e: { op: string; peer: string; error: string }) => void;

  constructor() {
    this.ready = E2ee.supported ? this.init() : Promise.resolve();
  }

  private async init() {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => this.onError?.(e.data);
    URL.revokeObjectURL(url);
    this.pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    this.pubJwk = await crypto.subtle.exportKey('jwk', this.pair.publicKey);
    this.newOwn();
  }

  private newOwn() {
    this.ownRaw = crypto.getRandomValues(new Uint8Array(16));
    this.ownId = (this.ownId + 1) & 255;
    this.worker?.postMessage({ t: 'own', id: this.ownId, raw: this.ownRaw });
  }

  /** Mi clave pública de la sesión (se manda a cada pareja). */
  pub(): JsonWebKey | undefined {
    return this.pubJwk;
  }

  /** Llega la clave pública de otro: se acuerda el secreto con él (ECDH) y se guarda su código de seguridad. */
  async onPeerPub(peer: string, jwk: JsonWebKey): Promise<void> {
    await this.ready;
    if (!this.pair || !this.pubJwk) return;
    const theirs = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, this.pair.privateKey, 256);
    const wrap = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
    // código de seguridad: huella de las dos claves públicas (en el mismo orden en ambos lados) -> 6 dígitos
    const ser = (k: JsonWebKey) => `${k.x}.${k.y}`, pair = [ser(this.pubJwk), ser(jwk)].sort().join('|');
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair)));
    const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    this.peers.set(peer, { wrap, code: String(n % 1000000).padStart(6, '0') });
  }

  /** El código de seguridad con ese jugador: si los dos ven el mismo, nadie se ha puesto en medio. */
  safetyCode(peer: string): string | undefined {
    return this.peers.get(peer)?.code;
  }

  /** Mi clave de emisor actual, envuelta para ese jugador. */
  async wrapOwn(peer: string): Promise<WrappedKey | undefined> {
    const p = this.peers.get(peer);
    if (!p) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array([this.ownId]) }, p.wrap, this.ownRaw);
    return { id: this.ownId, iv: b64(iv), ct: b64(ct) };
  }

  /** Llega la clave de emisor de otro jugador: se desenvuelve y se da al trabajador. */
  async onKey(peer: string, k: WrappedKey): Promise<boolean> {
    const p = this.peers.get(peer);
    if (!p || !this.worker) return false;
    try {
      const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(k.iv), additionalData: new Uint8Array([k.id]) }, p.wrap, unb64(k.ct));
      this.worker.postMessage({ t: 'key', peer, id: k.id, raw: new Uint8Array(raw) });
      return true;
    } catch {
      return false;
    }
  }

  /** Clave de emisor nueva (cuando alguien se va): hay que volver a mandarla a los que quedan. */
  rotate() {
    this.newOwn();
  }

  forget(peer: string) {
    this.peers.delete(peer);
  }

  /** Activa o desactiva el cifrado (op 'encrypt') o el descifrado (op 'decrypt') con ese jugador; mientras está apagado los fotogramas pasan sin tocar. */
  setMode(op: 'encrypt' | 'decrypt', peer: string, on: boolean) {
    this.worker?.postMessage({ t: 'mode', op, peer, on });
  }

  /** El transformador para el emisor (cifrar) o para el receptor de ese jugador (descifrar). */
  transform(operation: 'encrypt' | 'decrypt', peer: string) {
    return new RTCRtpScriptTransform(this.worker!, { operation, peer });
  }

  dispose() {
    this.worker?.terminate();
    this.peers.clear();
  }
}
