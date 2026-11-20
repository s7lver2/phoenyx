/*
 * Modulación de la voz: una cadena de nodos Web Audio entre la entrada y la salida, que se reconstruye al cambiar de preajuste y se afina en vivo.
 */
export type FxPreset = 'none' | 'deep' | 'chipmunk' | 'robot' | 'radio' | 'demon';
export const FX_PRESETS: readonly FxPreset[] = ['none', 'deep', 'chipmunk', 'robot', 'radio', 'demon'];
export interface FxParams {
  preset: FxPreset;
  /** Mezcla con la voz sin tocar (0 = solo original, 1 = solo efecto). */
  mix: number;
}
export const FX_DEFAULT: FxParams = { preset: 'none', mix: 1 };

export class FxChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private nodes: AudioNode[] = [];
  private dry: GainNode;
  private wet: GainNode;
  private p: FxParams = { ...FX_DEFAULT };

  constructor(
    private ctx: AudioContext,
    private hasWorklet: boolean,
  ) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
    this.apply();
  }

  set(next: Partial<FxParams>) {
    const prev = this.p.preset;
    this.p = { ...this.p, ...next };
    this.apply();
    if (this.p.preset !== prev) this.build();
  }

  private apply() {
    const t = this.ctx.currentTime,
      none = this.p.preset === 'none';
    this.dry.gain.setTargetAtTime(none ? 1 : 1 - this.p.mix, t, 0.02);
    this.wet.gain.setTargetAtTime(none ? 0 : this.p.mix, t, 0.02);
  }

  private build() {
    this.input.disconnect();
    this.input.connect(this.dry);
    for (const n of this.nodes) {
      try {
        n.disconnect();
        (n as OscillatorNode).stop?.();
      } catch {
        /* ya parado */
      }
    }
    this.nodes = [];
    const c = this.ctx,
      add = <T extends AudioNode>(n: T) => (this.nodes.push(n), n);
    const pitch = (ratio: number) => {
      const n = add(new AudioWorkletNode(c, 'px-pitch'));
      n.parameters.get('ratio')!.value = ratio;
      return n;
    };
    const chain = (...n: AudioNode[]) => {
      this.input.connect(n[0]);
      n.reduce((a, b) => (a.connect(b), b));
      n[n.length - 1].connect(this.wet);
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.7) => {
      const b = add(c.createBiquadFilter());
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const shaper = (k: number) => {
      const s = add(c.createWaveShaper()),
        a = new Float32Array(1024);
      for (let i = 0; i < a.length; i++) {
        const x = i / 511.5 - 1;
        a[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      s.curve = a;
      return s;
    };
    const ring = (hz: number) => {
      const g = add(c.createGain()),
        o = add(c.createOscillator());
      g.gain.value = 0;
      o.frequency.value = hz;
      o.connect(g.gain);
      o.start();
      return g;
    };
    switch (this.p.preset) {
      case 'deep':
        if (this.hasWorklet) chain(pitch(0.72), filt('lowshelf', 200));
        break;
      case 'chipmunk':
        if (this.hasWorklet) chain(pitch(1.55));
        break;
      case 'demon':
        if (this.hasWorklet) chain(pitch(0.6), shaper(6), filt('lowpass', 2600));
        break;
      case 'robot':
        chain(ring(55), filt('highpass', 180));
        break;
      case 'radio':
        chain(filt('highpass', 500), filt('lowpass', 3200), shaper(8));
        break;
      default:
    }
  }

  dispose() {
    this.p.preset = 'none';
    this.build();
    this.input.disconnect();
    this.output.disconnect();
  }
}
