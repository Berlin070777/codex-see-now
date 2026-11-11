import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { Observer } from '../desktop/core/observer.mjs';

function sendFrames(observer, from, color) {
  const width = 64, height = 36;
  const bytes = Buffer.alloc(width * height * 3, Buffer.from(color));
  for (let index = 0; index < 16; index++) observer.frame({ width, height, bytes, t: from + index / 8 });
}

test('an active desktop observation wakes Codex only once for a static scene and accepts a follow-up', { timeout: 6000 }, async (context) => {
  let finish;
  let interrupted = false;
  const calls = [];
  const conversation = {
    ask(value) {
      calls.push(value);
      return new Promise((resolve) => { finish = resolve; });
    },
    async steer(text) { calls.push(text); return true; },
    async stop() { interrupted = true; finish?.(); },
  };
  const observer = new Observer({ conversation, automatic: true, pace: 'dense', quality: 'low', scene: false });
  context.after(() => observer.stop());
  sendFrames(observer, 0, [200, 10, 20]);
  await once(observer, 'sheet');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sheets[0].frames.length, 1);
  await observer.question('Can you see a change?');
  assert.equal(calls[1], 'Can you see a change?');
  finish();
  sendFrames(observer, 2, [200, 10, 20]);
  await delay(1700);
  assert.equal(observer.state.queued, 0);
  assert.equal(calls.length, 2);
  await observer.stop();
  assert.equal(interrupted, true);
});

test('manual observation keeps chronological scene cuts without opening an automatic turn', async (context) => {
  const requests = [];
  const observer = new Observer({
    conversation: { async ask(input) { requests.push(input); }, async stop() {} },
    automatic: false, pace: 'normal', quality: 'low', scene: true,
  });
  context.after(() => observer.stop());
  sendFrames(observer, 0, [240, 10, 10]);
  sendFrames(observer, 2, [10, 230, 10]);
  sendFrames(observer, 4, [10, 10, 240]);
  observer.finishSource();
  assert.equal(requests.length, 0);
  await observer.question('What happened?');
  assert.deepEqual(requests[0].sheets.map(({ frames }) => frames.map(({ t }) => t)), [[0], [2], [4]]);
});
