import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('the installed launcher exposes a PNG as MCP image content', { timeout: 5000 }, async (context) => {
  const launcher = fileURLToPath(new URL('../plugins/codex-see-now/run.sh', import.meta.url));
  const child = spawn('/bin/sh', [launcher]);
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  let id = 0;

  async function call(method, params) {
    const reply = once(lines, 'line');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
    const [line] = await reply;
    const response = JSON.parse(line);
    assert.equal(response.id, id);
    assert.equal(response.error, undefined);
    return response.result;
  }

  const init = await call('initialize', { protocolVersion: '2025-11-25' });
  assert.equal(init.serverInfo.name, 'codex-see-now');
  const list = await call('tools/list');
  assert.ok(list.tools.some((tool) => tool.name === 'watch_screen'));
  const result = await call('tools/call', { name: 'vision_test' });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].mimeType, 'image/png');
  assert.equal(Buffer.from(result.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
  const missingSelection = await call('tools/call', { name: 'watch_screen' });
  assert.equal(missingSelection.isError, true);
  const closed = once(child, 'close');
  child.stdin.end();
  assert.deepEqual(await closed, [0, null]);
});
