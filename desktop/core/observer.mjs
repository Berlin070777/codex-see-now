import { EventEmitter } from 'node:events';
import { createPipeline } from '../../plugins/codex-see-now/vendor/dsh-see-now/pipeline.js';

export const PACES = {
  calm: { gap: 30000, cutAbs: 20, cutIsolatedAbs: 0, cutMcAbs: 0 },
  normal: { gap: 15000, cutAbs: 12 },
  dense: { gap: 8000, cutAbs: 7 },
  game: { gap: 20000, cutAbs: 80, integralSeconds: 30, cutIsolatedAbs: 0, cutJumpAbs: 0, cutMcAbs: 0 },
};
export const QUALITY = { low: 800, standard: 1066, high: 1280, ultra: 1600 };
const FPS = 8;
const QUEUE_SIZE = 4;
const AUTO_PROMPT = 'Screen observation update. Briefly describe what visibly changed and what matters to the user. If there is no useful update, reply with exactly SKIP.';

export class Observer extends EventEmitter {
  #conversation;
  #timer;
  #pipeline;
  #format;
  #time = -1;
  #queue = [];
  #lines = [];
  #lastSent = -Infinity;
  #pendingQuestion;
  #busy;
  #stopped = false;
  #paused = false;
  #automatic;
  #scene;
  #pace;
  #quality;
  #batch;
  #dropped = 0;
  #frames = 0;
  #retained = 0;
  #encode;
  #levels = [];
  #hasAudio;
  #sourceEnded = false;

  constructor({ conversation, automatic, pace, quality, scene, batch, audio, encode = (sheet) => sheet }) {
    super();
    this.#conversation = conversation;
    this.#automatic = Boolean(automatic);
    this.#scene = Boolean(scene);
    this.#pace = PACES[pace] ?? PACES.normal;
    this.#quality = quality;
    this.#encode = encode;
    this.#hasAudio = Boolean(audio);
    this.#batch = Number.isInteger(batch) ? Math.min(3, Math.max(1, batch)) : 1;
    this.#timer = setInterval(() => {
      if (this.#paused) return;
      this.#flush();
      void this.#pump();
    }, 1500);
  }

  get state() {
    return {
      busy: Boolean(this.#busy), queued: this.#queue.length, dropped: this.#dropped,
      paused: this.#paused, ended: this.#sourceEnded, seconds: Math.max(0, this.#time), frames: this.#frames, retained: this.#retained,
    };
  }

  pause(value) {
    this.#paused = value;
    if (value) this.#queue.length = 0;
    this.emit('state', this.state);
  }

  frame({ bytes, width, height, t }) {
    if (this.#stopped || this.#paused || this.#sourceEnded) return;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 ||
        Math.max(width, height) > QUALITY.ultra || bytes?.byteLength !== width * height * 3 ||
        !Number.isFinite(t) || t < this.#time) return;
    this.#time = t;
    this.#frames++;
    if (!this.#format || this.#format.width !== width || this.#format.height !== height) {
      this.#flush();
      this.#format = { width, height };
      const count = this.#scene ? 1 : this.#quality === 'ultra' ? 2 : 4;
      const { gap, ...thresholds } = this.#pace;
      this.#pipeline = createPipeline({
        width, height, fps: FPS, region: { w: width, h: height },
        maxFrames: count, preferFrames: count, audioStrip: false,
        regionAudioStrip: this.#hasAudio,
        audio: { levels: (first, last) => this.#loudness(first, last) },
        ...thresholds, silentFloorSec: Infinity, queueDepth: QUEUE_SIZE, diagnosticLimit: 256,
      });
    }
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#pipeline.push({ t, buf });
    this.#drain();
    if (this.#queue.length) void this.#pump();
  }

  #drain() {
    let sheet;
    while ((sheet = this.#pipeline?.take())) {
      if (this.#queue.length === QUEUE_SIZE) {
        this.#queue.shift();
        this.#dropped++;
      }
      this.#queue.push(sheet);
      this.#retained += sheet.frames.length;
      this.emit('sheet', sheet);
      this.emit('state', this.state);
    }
  }

  #flush() {
    this.#pipeline?.flushPending();
    this.#drain();
  }

  async question(value, { peek = false } = {}) {
    if (this.#stopped) return;
    const text = String(value ?? '').trim().slice(0, 4000);
    if (!text) return;
    if (peek && this.#paused) throw new Error('Hide the overlapping window before taking a fresh look.');
    this.emit('question', text);
    if (!peek && this.#busy && await this.#conversation.steer(text)) return;
    if (this.#stopped) return;
    this.#pendingQuestion = { text, peek };
    void this.#pump();
  }

  audioLevel(db) {
    if (!this.#hasAudio || this.#stopped || this.#paused || !Number.isFinite(db) || db < -90 || db > 0) return;
    this.#levels.push({ wall: Date.now(), db });
    if (this.#levels.length > 480) this.#levels.shift();
  }

  #loudness(first, last) {
    const db = this.#levels.filter(({ wall }) => wall >= first && wall <= last).map((sample) => sample.db);
    return db.length ? { step: .125, db } : null;
  }

  transcript(line) {
    if (this.#stopped || !line.text?.trim()) return;
    this.#lines.push(line);
    while (this.#lines.length > 12) this.#lines.shift();
    this.emit('transcript', line);
    void this.#pump();
  }

  finishSource() {
    if (this.#stopped || this.#sourceEnded) return;
    this.#sourceEnded = true;
    this.#pipeline?.finish();
    this.#drain();
    this.emit('state', this.state);
    void this.#pump();
  }

  async #pump() {
    if (this.#stopped || this.#busy) return;
    const manual = this.#pendingQuestion;
    const due = Date.now() - this.#lastSent >= this.#pace.gap;
    const enough = this.#queue.length >= this.#batch || (this.#sourceEnded && this.#queue.length) ||
      (this.#lastSent === -Infinity && this.#queue.length) || this.#lines.length;
    if (!manual && (!this.#automatic || this.#paused || !enough || !due)) return;
    this.#pendingQuestion = undefined;
    if (manual?.peek && this.#pipeline) {
      const sheet = this.#pipeline.flushNow(null, 'user');
      if (sheet) {
        if (this.#queue.length === QUEUE_SIZE) this.#queue.shift();
        this.#queue.push(sheet);
        this.emit('sheet', sheet);
      }
    } else if (manual && !this.#paused) {
      this.#flush();
    }
    const sheets = this.#queue.splice(0).map(this.#encode);
    const lines = this.#lines.splice(0);
    const audio = lines.map(({ from, to, text }) => `[${from.toFixed(1)}–${to.toFixed(1)}s] ${text}`).join('\n');
    const text = (manual?.text ?? AUTO_PROMPT) + (audio ? '\n\nMachine transcript (may contain errors):\n' + audio : '');
    this.#lastSent = Date.now();
    this.#busy = this.#conversation.ask({ text, sheets });
    this.emit('state', this.state);
    try {
      await this.#busy;
    } catch (error) {
      if (!this.#stopped) {
        this.#automatic = false;
        this.emit('problem', error.message);
      }
    } finally {
      this.#busy = undefined;
      this.emit('state', this.state);
      if (!this.#stopped && this.#pendingQuestion) void this.#pump();
    }
  }

  async stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#pendingQuestion = undefined;
    this.#queue.length = 0;
    this.#lines.length = 0;
    this.#pipeline = undefined;
    await this.#conversation.stop();
  }
}
