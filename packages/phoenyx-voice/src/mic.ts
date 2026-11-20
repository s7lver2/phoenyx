/*
 * El micrófono: permiso, dispositivos y flujo. El navegador es quien pregunta (una vez); lo demás —cuál usar, cuánto, si se prueba— se hace desde el juego.
 * Sin HTTPS (salvo localhost) el navegador ni lo ofrece: estado 'unavailable'.
 */
export type MicState = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unavailable';
export interface MicDevice {
  id: string;
  label: string;
}

export class Mic {
  state: MicState = 'unknown';
  devices: MicDevice[] = [];
  private subs = new Set<() => void>();
  onChange = (f: () => void) => (this.subs.add(f), () => void this.subs.delete(f));
  private emit() {
    this.subs.forEach((f) => f());
  }

  /** Mira el permiso sin pedirlo (Permissions API; Firefox no la tiene para el micro: se queda en 'prompt' hasta el primer intento). */
  async query(): Promise<MicState> {
    if (!navigator.mediaDevices?.getUserMedia) return this.set('unavailable');
    try {
      const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      const apply = () => void this.set(p.state === 'granted' ? 'granted' : p.state === 'denied' ? 'denied' : 'prompt');
      apply();
      p.onchange = () => (apply(), void this.refresh());
    } catch {
      if (this.state === 'unknown') this.set('prompt');
    }
    if (this.state === 'granted') await this.refresh();
    return this.state;
  }

  private set(s: MicState) {
    if (s !== this.state) ((this.state = s), this.emit());
    return s;
  }

  /** La lista de micrófonos (sin permiso no traen nombre). */
  async refresh(): Promise<MicDevice[]> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `MICROPHONE ${i + 1}` }));
    } catch {
      this.devices = [];
    }
    this.emit();
    return this.devices;
  }

  /** Pide el micrófono (el aviso del navegador sale aquí). Sin proceso del navegador: el juego aplica el suyo (puerta, ganancia). */
  async request(deviceId?: string, browserDsp = true): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) throw (this.set('unavailable'), new Error('MIC NEEDS HTTPS'));
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: browserDsp, noiseSuppression: browserDsp, autoGainControl: false, channelCount: 1, sampleRate: { ideal: 48000 } },
        video: false,
      });
      this.set('granted');
      void this.refresh();
      return s;
    } catch (e) {
      const n = (e as DOMException).name;
      if (n === 'NotFoundError' || n === 'OverconstrainedError') throw (this.set(this.state === 'granted' ? 'granted' : 'unavailable'), e);
      throw (this.set('denied'), e);
    }
  }
}
