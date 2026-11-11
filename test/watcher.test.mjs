import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setImmediate as immediate } from 'node:timers/promises';
import test from 'node:test';
import { startWatch } from '../plugins/codex-see-now/watch.mjs';
import { captureArgs } from '../plugins/codex-see-now/vendor/dsh-see-now/capture.js';

function framesFrom(colors) {
  return ({ width, height, fps, onFrame }) => {
    let stopped = false;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const images = colors.map((color) => Buffer.alloc(width * height * 3, Buffer.from(color)));
    setImmediate(() => {
      let index = 0;
      for (const buf of images) {
        for (let n = 0; n < fps * 2 && !stopped; n++) {
          onFrame({ i: index, t: index++ / fps, buf });
        }
      }
    });
    return {
      done,
      stop() {
        stopped = true;
        finish();
      },
    };
  };
}

test('a static capture returns only one reference frame', async () => {
  const watch = startWatch({ display: 0, seconds: 0.03, live: false }, framesFrom([[150, 200, 50]]));
  const result = await watch.collect(new AbortController().signal);
  assert.equal(result.failure, undefined);
  assert.equal(result.sheets.length, 1);
  assert.deepEqual(result.sheets[0].frames.map((frame) => frame.t), [0]);
});

test('hard changes keep their order and are encoded as PNG', async () => {
  const watch = startWatch({ display: 0, seconds: 0.03, live: false }, framesFrom([
    [250, 40, 20], [30, 240, 30], [30, 20, 250],
  ]));
  const result = await watch.collect(new AbortController().signal);
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.sheets.flatMap((sheet) => sheet.frames.map((frame) => frame.t)), [0, 2, 4]);
  assert.equal(result.sheets[0].png.subarray(1, 4).toString('ascii'), 'PNG');
});

test('live capture yields its initial image and stop discards unread images', async () => {
  const watch = startWatch({ display: 0, seconds: 30, live: true }, framesFrom([[50, 140, 220]]));
  const result = await watch.next();
  assert.equal(result.done, false);
  assert.equal(result.sheets.length, 1);
  await watch.stop();
  const stopped = await watch.next();
  assert.equal(stopped.done, true);
  assert.deepEqual(stopped.sheets, []);
});

test('aborting a short capture stops its source immediately', async () => {
  let stopped = false;
  const startFrames = (options) => {
    const source = framesFrom([[125, 90, 55]])(options);
    return { ...source, stop() { stopped = true; source.stop(); } };
  };
  const watch = startWatch({ display: 0, seconds: 30, live: false }, startFrames);
  const controller = new AbortController();
  const capture = watch.collect(controller.signal);
  await immediate();
  controller.abort();
  await assert.rejects(capture, { name: 'AbortError' });
  assert.equal(stopped, true);
  assert.equal(watch.done, true);
});

test('FFmpeg crops before scaling so pixels outside the region are excluded', (context) => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return context.skip('FFmpeg not installed');
  const args = captureArgs({
    platform: 'darwin',
    source: { kind: 'screen', regionPercent: { x: 50, y: 0, width: 50, height: 100 }, fit: 'contain' },
    width: 80, height: 40, fps: 8,
  });
  const filter = args[args.indexOf('-vf') + 1];
  const ffmpeg = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=red:size=160x40,drawbox=x=80:y=0:w=80:h=40:c=blue:t=fill',
    '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr?.toString());
  assert.equal(ffmpeg.stdout.length, 80 * 40 * 3);
  for (let i = 0; i < ffmpeg.stdout.length; i += 3) {
    assert.ok(ffmpeg.stdout[i] < 10 && ffmpeg.stdout[i + 2] > 220);
  }
});
