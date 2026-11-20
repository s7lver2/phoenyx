/*
 * La captura: micrófono -> ganancia -> puerta de ruido (con VAD) -> modulación -> flujo de salida (lo que se envía a los demás).
 * Todo cambia en vivo. Si el navegador no tiene AudioWorklet, no hay puerta ni cambio de tono (el resto sigue).
 */
import { FxChain, type FxParams } from './fx';
import { WORKLET_SRC } from './worklet';

export interface CaptureOptions {
  gain: number; // 0-3
  gate: number; // umbral 0-1 (0 = sin puerta)
  fx: Partial<FxParams>;
}
export interface Capture {
  /** El flujo ya procesado: lo que se manda a la red. */
  stream: MediaStream;
  track: MediaStreamTrack;
  /** Nivel de entrada actual (0-1, pico), antes de la puerta. */
  level(): number;
  /** La puerta está abierta (se detecta voz). */
  open(): boolean;
  set(o: Partial<CaptureOptions>): void;
  dispose(): void;
}

const loaded = new WeakSet<BaseAudioContext>();
async function worklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return false;
  if (loaded.has(ctx)) return true;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    loaded.add(ctx);
    return true;
  } catch {
    return false;
  }
}

export async function createCapture(ctx: AudioContext, raw: MediaStream, o: CaptureOptions): Promise<Capture> {
  const wk = await worklet(ctx);
  const src = ctx.createMediaStreamSource(raw),
    gain = ctx.createGain(),
    pre = ctx.createAnalyser(),
    dest = ctx.createMediaStreamDestination();
  pre.fftSize = 512;
  const fx = new FxChain(ctx, wk);
  let gate: AudioWorkletNode | undefined,
    open = true;
  src.connect(gain);
  gain.connect(pre); // (el medidor mira la entrada, antes de la puerta: se ve cuánto falta para abrirla)
  if (wk) {
    gate = new AudioWorkletNode(ctx, 'px-gate');
    gate.port.onmessage = (e) => (open = !!e.data);
    gain.connect(gate).connect(fx.input);
  } else gain.connect(fx.input);
  fx.output.connect(dest);
  const buf = new Uint8Array(pre.fftSize);
  const set = (n: Partial<CaptureOptions>) => {
    const t = ctx.currentTime;
    if (n.gain !== undefined) gain.gain.setTargetAtTime(n.gain, t, 0.02);
    if (n.gate !== undefined && gate) gate.parameters.get('threshold')!.setValueAtTime(n.gate, t);
    if (n.fx) fx.set(n.fx);
  };
  set(o);
  return {
    stream: dest.stream,
    track: dest.stream.getAudioTracks()[0],
    level: () => {
      pre.getByteTimeDomainData(buf);
      let m = 0;
      for (const v of buf) m = Math.max(m, Math.abs(v - 128));
      return m / 128;
    },
    open: () => open,
    set,
    dispose: () => {
      raw.getTracks().forEach((t) => t.stop());
      fx.dispose();
      [src, gain, pre, dest].forEach((n) => n.disconnect());
      gate?.disconnect();
    },
  };
}
