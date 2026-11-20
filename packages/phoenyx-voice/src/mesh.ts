/*
 * Transporte en malla: WebRTC entre cada pareja de jugadores (vale para salas pequeñas). La señalización va por donde diga el juego (`Signaling`):
 * la librería no sabe de sockets. Cada pareja abre UNA conexión con un transceptor de audio desde el principio; el micrófono se engancha
 * después con replaceTrack, sin renegociar. Inicia la oferta el de id menor (así no se cruzan).
 *
 * Es una implementación de `Transport`: otra (un SFU, por ejemplo) puede ocupar su sitio sin tocar el resto de la librería.
 */
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
}

type Sig = { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };
interface Peer {
  pc: RTCPeerConnection;
  pending: RTCIceCandidateInit[];
}

export class Mesh implements Transport {
  onTrack?: (id: string, stream: MediaStream) => void;
  onDrop?: (id: string) => void;
  onState?: () => void;
  private peers = new Map<string, Peer>();
  private me = '';
  private track: MediaStreamTrack | null = null;
  private off: () => void;

  constructor(
    private sig: Signaling,
    private o: MeshOptions = {},
  ) {
    this.off = sig.on(this.onSignal);
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
    for (const p of this.peers.values()) void p.pc.getSenders().find((x) => !x.track || x.track.kind === 'audio')?.replaceTrack(track);
  }

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
      if (this.track) void tr.sender.replaceTrack(this.track);
    }
    pc.onicecandidate = (e) => e.candidate && this.sig.send(id, { ice: e.candidate.toJSON() } satisfies Sig);
    pc.ontrack = (e) => this.onTrack?.(id, e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      this.onState?.();
      if (pc.connectionState === 'failed' && this.peers.get(id) === p) (this.drop(id), this.open(id));
    };
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
    this.onDrop?.(id);
  }

  private onSignal = async (from: string, data: unknown) => {
    const d = data as Sig;
    const p = this.peers.get(from) ?? this.open(from);
    try {
      if (d.sdp) {
        await p.pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === 'offer') {
          const tr = p.pc.getTransceivers()[0];
          if (tr) (tr.direction = 'sendrecv'), void tr.sender.replaceTrack(this.track);
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
  }
}
