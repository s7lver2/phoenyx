/*
 * Transporte en malla: WebRTC entre cada pareja de jugadores (vale para salas pequeñas). La señalización va por donde diga el juego (`Signaling`):
 * la librería no sabe de sockets. Cada pareja abre UNA conexión con un transceptor de audio desde el principio; el micrófono se engancha
 * después con replaceTrack, sin renegociar. Inicia la oferta el de id menor (así no se cruzan).
 *
 * Es una implementación de `Transport`: otra (un SFU, por ejemplo) puede ocupar su sitio sin tocar el resto de la librería.
 */
import type { E2ee, WrappedKey } from './e2ee';

export interface Signaling {
  send(to: string, data: unknown): void;
  /** Recibir señales de los demás; devuelve la función para dejar de escuchar. */
  on(cb: (from: string, data: unknown) => void): () => void;
}

export interface Transport {
  /** Los jugadores de la sala ahora: se abren las conexiones que faltan y se cierran las de quien se fue. */
  sync(me: string, ids: string[]): void;
  /** La pista que se envía a todos (null = ninguna). */
  setTrack(track: MediaStreamTrack | null): void;
  /** Conexiones establecidas y las que debería haber. */
  linked(): [number, number];
  /** Llega la voz de alguien. */
  onTrack?: (id: string, stream: MediaStream) => void;
  /** Alguien se fue (o su conexión se cerró). */
  onDrop?: (id: string) => void;
  /** Cambió el estado de alguna conexión. */
  onState?: () => void;
  close(): void;
}

export interface MeshOptions {
  iceServers?: RTCIceServer[];
  /** Bits por segundo de Opus (por defecto 64000). */
  bitrate?: number;
  /** Cifrado de extremo a extremo (ver e2ee.ts). Sin él, la voz va en claro entre los jugadores (cifrada en tránsito por WebRTC, pero no de extremo a extremo). */
  e2ee?: E2ee;
  /**
   * 'optional': si el otro no puede cifrar, se habla en claro con él. 'required': solo se envía voz a quien ha confirmado el cifrado y se descarta
   * todo lo que llegue sin cifrar.
   */
  e2eeMode?: 'optional' | 'required';
}

/** Mensajes del cifrado: clave pública, 'ya descifro' y la clave de emisor envuelta. */
interface EMsg {
  pub?: JsonWebKey;
  ready?: 1;
  key?: WrappedKey;
}
type Sig = { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit; e?: EMsg };
interface Peer {
  pc: RTCPeerConnection;
  pending: RTCIceCandidateInit[];
  /** Estado del cifrado con este jugador. */
  keyed?: boolean; // tengo su clave pública (secreto acordado)
  recvOn?: boolean; // mi receptor descifra
  theirReady?: boolean; // el suyo ya descifra: puedo cifrar lo que le mando
  rxSet?: boolean; // el transformador de mi receptor está puesto
  txSet?: boolean; // el transformador de mi emisor está puesto
  sendOn?: boolean; // mi emisor cifra y ya manda voz
  sentReady?: boolean; // ya le avisé de que descifro
}

export class Mesh implements Transport {
  onTrack?: (id: string, stream: MediaStream) => void;
  onDrop?: (id: string) => void;
  onState?: () => void;
  private peers = new Map<string, Peer>();
  private me = '';
  private track: MediaStreamTrack | null = null;
  private off: () => void;
  private ee?: E2ee;

  constructor(
    private sig: Signaling,
    private o: MeshOptions = {},
  ) {
    this.off = sig.on(this.onSignal);
    this.ee = o.e2ee;
  }

  /** Cuántas conexiones van cifradas y cuántas hay. */
  secure(): [number, number] {
    return [[...this.peers.values()].filter((p) => p.sendOn && p.recvOn).length, this.peers.size];
  }
  /** El código de seguridad con ese jugador, para compararlo en voz alta. */
  safetyCode(id: string) {
    return this.ee?.safetyCode(id);
  }
  private get required() {
    return !!this.ee && this.o.e2eeMode === 'required';
  }

  /** Opus para voz: mono a `bitrate` (el de serie ronda 32 kb/s), corrección de pérdidas en banda (FEC) y banda completa a 48 kHz. */
  private opus(sdp = '') {
    const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
    if (!pt) return sdp;
    const strip = /;?(maxaveragebitrate|stereo|sprop-stereo|useinbandfec|cbr|maxplaybackrate)=[^;\r\n]*/g;
    return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\r\n]*)`), (_, f: string) => `a=fmtp:${pt} ${f.replace(strip, '')};maxaveragebitrate=${this.o.bitrate ?? 64000};useinbandfec=1;stereo=0;sprop-stereo=0;cbr=0;maxplaybackrate=48000`);
  }

  sync(me: string, ids: string[]) {
    this.me = me;
    const want = new Set(ids.filter((i) => i !== me));
    for (const id of want) if (!this.peers.has(id)) this.open(id);
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.drop(id);
  }

  setTrack(track: MediaStreamTrack | null) {
    this.track = track;
    for (const p of this.peers.values()) void this.audioSender(p)?.replaceTrack(this.trackFor(p));
  }
  private audioSender = (p: Peer) => p.pc.getSenders().find((x) => !x.track || x.track.kind === 'audio');
  /** En modo 'required' no se manda voz a quien aún no ha confirmado el cifrado. */
  private trackFor = (p: Peer) => (this.required && !p.sendOn ? null : this.track);

  linked(): [number, number] {
    return [[...this.peers.values()].filter((p) => p.pc.connectionState === 'connected').length, this.peers.size];
  }

  private open(id: string) {
    const pc = new RTCPeerConnection({ iceServers: this.o.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }] });
    const p: Peer = { pc, pending: [] };
    this.peers.set(id, p);
    if (this.me < id) {
      // solo quien ofrece crea el transceptor: el que responde usa el que trae la oferta (uno creado antes con addTransceiver no se asocia a ella y su micrófono no sonaba: voz en un solo sentido)
      const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (this.ee) void this.e2eeStep(id); // (el transformador, antes de que salga audio)
      if (this.track && !this.required) void tr.sender.replaceTrack(this.track);
    }
    pc.onicecandidate = (e) => e.candidate && this.sig.send(id, { ice: e.candidate.toJSON() } satisfies Sig);
    pc.ontrack = (e) => (void this.e2eeStep(id), this.onTrack?.(id, e.streams[0] ?? new MediaStream([e.track])));
    pc.onconnectionstatechange = () => {
      this.onState?.();
      if (pc.connectionState === 'failed' && this.peers.get(id) === p) (this.drop(id), this.open(id));
    };
    if (this.ee) void this.hello(id);
    if (this.me < id) {
      void (async () => {
        try {
          const o = await pc.createOffer();
          await pc.setLocalDescription({ type: 'offer', sdp: this.opus(o.sdp) });
          this.sig.send(id, { sdp: pc.localDescription!.toJSON() } satisfies Sig);
        } catch {
          /* se reintenta al fallar la conexión */
        }
      })();
    }
    return p;
  }

  private drop(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    p.pc.close();
    this.ee?.forget(id);
    this.onDrop?.(id);
    // alguien se fue: clave nueva para los que quedan (el que se fue no puede seguir descifrando)
    if (this.ee && p.sendOn) void this.rotate();
  }

  // ── cifrado ──────────────────────────────────────────────────────────────

  /** Se presenta: la clave pública de la sesión (quien no sepa cifrar no contesta y se queda en claro, salvo en modo 'required'). */
  private async hello(id: string) {
    await this.ee!.ready;
    const pub = this.ee!.pub();
    if (!pub || !this.peers.has(id)) return;
    this.sig.send(id, { e: { pub } } satisfies Sig);
  }

  /**
   * Avanza el estado del cifrado con ese jugador cuanto se pueda (lo llaman todos los eventos que lo desbloquean). Los transformadores se ponen
   * en cuanto existe el emisor y el receptor (antes de que pase audio: puestos después, el navegador sigue mandando el audio sin pasar por ellos) y
   * pasan los fotogramas tal cual hasta que se activan.
   */
  private async e2eeStep(id: string) {
    const p = this.peers.get(id),
      ee = this.ee;
    if (!p || !ee) return;
    const rx = p.pc.getReceivers().find((r) => r.track?.kind === 'audio'),
      tx = this.audioSender(p);
    if (rx && !p.rxSet) {
      (rx as unknown as { transform: unknown }).transform = ee.transform('decrypt', id);
      p.rxSet = true;
      ee.setMode('decrypt', id, this.required); // (en 'required' descifra desde ya: lo que llegue sin cifrar se descarta)
    }
    if (tx && !p.txSet) {
      (tx as unknown as { transform: unknown }).transform = ee.transform('encrypt', id);
      p.txSet = true;
      ee.setMode('encrypt', id, this.required);
    }
    if (p.rxSet && p.keyed && !p.recvOn) {
      ee.setMode('decrypt', id, true);
      p.recvOn = true;
    }
    if (p.recvOn && !p.sentReady) {
      p.sentReady = true; // (mi receptor ya descifra y tengo su clave pública: le aviso y le mando mi clave de emisor)
      const key = await ee.wrapOwn(id);
      if (key) this.sig.send(id, { e: { ready: 1, key } } satisfies Sig);
    }
    if (p.txSet && p.theirReady && !p.sendOn) {
      ee.setMode('encrypt', id, true);
      p.sendOn = true;
      void tx?.replaceTrack(this.trackFor(p));
      this.onState?.();
    }
  }

  private async rotate() {
    const ee = this.ee;
    if (!ee) return;
    ee.rotate();
    for (const [id, p] of this.peers) {
      if (!p.recvOn || !p.keyed) continue;
      const key = await ee.wrapOwn(id);
      if (key) this.sig.send(id, { e: { key } } satisfies Sig);
    }
  }

  private async onE(from: string, p: Peer, m: EMsg) {
    const ee = this.ee;
    if (!ee) return;
    if (m.pub) {
      await ee.onPeerPub(from, m.pub);
      p.keyed = true;
    }
    if (m.key) await ee.onKey(from, m.key);
    if (m.ready) p.theirReady = true;
    await this.e2eeStep(from);
  }

  private onSignal = async (from: string, data: unknown) => {
    const d = data as Sig;
    const p = this.peers.get(from) ?? this.open(from);
    try {
      if (d.e) return void (await this.onE(from, p, d.e));
      if (d.sdp) {
        await p.pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === 'offer') {
          const tr = p.pc.getTransceivers()[0];
          void this.e2eeStep(from); // (primero el transformador, luego la pista)
          if (tr) (tr.direction = 'sendrecv'), void tr.sender.replaceTrack(this.trackFor(p));
          const a = await p.pc.createAnswer();
          await p.pc.setLocalDescription({ type: 'answer', sdp: this.opus(a.sdp) });
          this.sig.send(from, { sdp: p.pc.localDescription!.toJSON() } satisfies Sig);
        }
        for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      } else if (d.ice) {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.ice).catch(() => {});
        else p.pending.push(d.ice);
      }
    } catch {
      /* señal inválida o fuera de orden: se ignora */
    }
  };

  close() {
    this.off();
    [...this.peers.keys()].forEach((id) => this.drop(id));
    this.ee?.dispose();
  }
}
