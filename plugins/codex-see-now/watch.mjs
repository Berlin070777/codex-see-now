import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { spawnFrames } from './vendor/dsh-see-now/capture.js';
import { createPipeline } from './vendor/dsh-see-now/pipeline.js';

const WIDTH = 768;
const HEIGHT = 432;
const FPS = 8;
const MAX_SHEETS = 4;
const STARTUP_MS = 8000;
const RETENTION_MS = 30000;

export function startWatch({ display, region, seconds, live }, startFrames = spawnFrames) {
  const pipeline = createPipeline({
    width: WIDTH, height: HEIGHT, fps: FPS,
    region: { w: WIDTH, h: HEIGHT },
    maxFrames: 4, preferFrames: 4, audioStrip: false,
    silentFloorSec: Infinity, oneShot: live, queueDepth: MAX_SHEETS,
  });

  const events = new EventEmitter();
  const queue = [];
  let frames = 0;
  let dropped = 0;
  let nonBlack = false;
  let endReason;
  let failure;
  let captureTimer;
  let cleanupTimer;
  let done = false;

  function drainPipeline() {
    let sheet;
    while ((sheet = pipeline.take())) {
      if (queue.length === MAX_SHEETS) {
        queue.shift();
        dropped++;
      }
      queue.push(sheet);
    }
    events.emit('change');
  }

  const source = {
    kind: 'screen',
    device: `Capture screen ${display}`,
    // RGB input avoids the red/blue swap observed on macOS 26 with NV12 screen input.
    pixelFormat: 'bgr0',
    regionPercent: region,
    fit: 'contain',
  };
  const child = startFrames({
    source, width: WIDTH, height: HEIGHT, fps: FPS, engine: 'avfoundation',
    onFrame(frame) {
      if (endReason) return;
      if (frames++ === 0) {
        clearTimeout(startupTimer);
        captureTimer = setTimeout(() => finish('expired'), seconds * 1000);
      }
      if (!nonBlack) {
        // Skip the black letterbox when deciding whether the captured image is blank.
        nonBlack = frame.buf.some((value) => value > 8);
      }
      pipeline.push(frame);
      drainPipeline();
    },
  });

  function finish(reason) {
    if (endReason) return;
    endReason = reason;
    child.stop();
  }

  const startupTimer = setTimeout(() => finish('startup_timeout'), STARTUP_MS);
  const batchTimer = setInterval(() => {
    if (endReason) return;
    pipeline.flushPending();
    drainPipeline();
  }, 3000);

  const settled = child.done
    .catch((error) => {
      failure = error.code === 'ENOENT'
        ? 'FFmpeg was not found. Install it with brew install ffmpeg.'
        : `Screen capture failed. Check the display number and macOS Screen & System Audio Recording permission. ${error.message}`;
    })
    .finally(() => {
      clearTimeout(startupTimer);
      clearTimeout(captureTimer);
      clearInterval(batchTimer);
      if (endReason === 'expired' && nonBlack) {
        pipeline.finish();
        drainPipeline();
      } else {
        queue.length = 0;
      }
      if (!failure && (endReason === 'startup_timeout' || (endReason === 'expired' && !nonBlack))) {
        failure = 'No visible screen frames arrived. Check the display, unlock the Mac, and grant the app that starts FFmpeg Screen & System Audio Recording access in macOS settings. A fully black selection can also cause this result.';
      }
      done = true;
      cleanupTimer = setTimeout(() => { queue.length = 0; }, RETENTION_MS);
      cleanupTimer.unref();
      events.emit('change');
    });

  return {
    id: randomUUID(),
    live,
    get done() { return done; },
    async next({ signal, waitMs = 10000 } = {}) {
      const timeout = AbortSignal.timeout(waitMs);
      const waiting = signal ? AbortSignal.any([timeout, signal]) : timeout;
      while (!done && (!queue.length || !nonBlack) && !waiting.aborted) {
        try {
          await once(events, 'change', { signal: waiting });
        } catch (error) {
          if (!waiting.aborted) throw error;
        }
      }
      if (signal?.aborted) throw signal.reason;
      const sheets = nonBlack ? queue.splice(0, 1) : [];
      return { sheets, remaining: queue.length, done, dropped, failure };
    },
    async collect(signal) {
      const cancel = () => finish('cancelled');
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        await settled;
        signal.throwIfAborted();
        return { sheets: queue.splice(0), done, dropped, failure };
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
    async stop() {
      finish('cancelled');
      await settled;
      clearTimeout(cleanupTimer);
      queue.length = 0;
    },
  };
}
