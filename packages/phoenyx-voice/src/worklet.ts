/*
 * Los procesadores de audio (AudioWorklet), como texto: se cargan con un Blob, sin archivos aparte que servir.
 *   px-gate   puerta de ruido con VAD: abre sobre el umbral (con retención) y avisa por el puerto cuando cambia
 *   px-pitch  cambio de tono sin cambiar la duración (dos lecturas de una línea de retardo, mezcladas con ventana triangular)
 */
export const WORKLET_SRC = /* js */ `
class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'threshold', defaultValue: 0.02, minValue: 0, maxValue: 1 }, { name: 'hold', defaultValue: 0.15, minValue: 0, maxValue: 2 }]; }
  constructor() { super(); this.g = 0; this.env = 0; this.left = 0; this.open = false; this.n = 0; }
  process(inputs, outputs, params) {
    const x = inputs[0][0], y = outputs[0][0];
    if (!x) return true;
    const thr = params.threshold[0], hold = params.hold[0] * sampleRate;
    let peak = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
    this.env = peak > this.env ? peak : this.env * 0.995;
    if (thr <= 0 || this.env > thr) { this.left = hold; }
    else this.left -= x.length;
    const want = thr <= 0 || this.left > 0 ? 1 : 0;
    const k = want > this.g ? 0.05 : 0.002; // sube en ~20 muestras, baja en ~500 (sin clics)
    for (let i = 0; i < x.length; i++) { this.g += (want - this.g) * k; y[i] = x[i] * this.g; }
    const open = want === 1 && (thr <= 0 ? this.env > 0.01 : true);
    if (open !== this.open && ++this.n >= 1) { this.open = open; this.port.postMessage(open); }
    return true;
  }
}
registerProcessor('px-gate', Gate);

class Pitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2 }]; }
  constructor() { super(); this.W = Math.round(sampleRate * 0.05); this.L = this.W * 4; this.buf = new Float32Array(this.L); this.w = 0; this.p = 0; }
  process(inputs, outputs, params) {
    const x = inputs[0][0], y = outputs[0][0];
    if (!x) return true;
    const r = params.ratio[0], W = this.W, L = this.L, b = this.buf;
    for (let n = 0; n < x.length; n++) {
      b[this.w] = x[n];
      let out = 0;
      for (let h = 0; h < 2; h++) {
        const ph = (this.p + h * 0.5) % 1, d = ph * W, rp = (this.w - d + L) % L, i0 = Math.floor(rp), f = rp - i0;
        out += (b[i0] * (1 - f) + b[(i0 + 1) % L] * f) * (1 - Math.abs(2 * ph - 1));
      }
      y[n] = out;
      this.w = (this.w + 1) % L;
      this.p += (1 - r) / W;
      this.p -= Math.floor(this.p);
    }
    return true;
  }
}
registerProcessor('px-pitch', Pitch);
`;
