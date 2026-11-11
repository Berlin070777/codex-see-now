import { randomInt } from 'node:crypto';
import { startWatch } from './watch.mjs';
import { drawGlyphs, fillRect } from './vendor/dsh-see-now/sheet.js';
import { encodePng } from './vendor/dsh-see-now/png.js';

const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const selection = {
  display: { ...integer(0, 15), default: 0, description: 'AVFoundation display number, starting at 0.' },
  region: {
    ...object({
      x: integer(0, 99), y: integer(0, 99),
      width: integer(1, 100), height: integer(1, 100),
    }, ['x', 'y', 'width', 'height']),
    description: 'Rectangle as integer percentages of the selected display, measured from the upper left.',
  },
  entireDisplay: { type: 'boolean', description: 'Set true only if the user explicitly requests the entire display.' },
};
const sessionId = { type: 'string' };
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export const tools = [
  {
    name: 'vision_test',
    description: 'Return a synthetic image containing a random six digit code. Does not access the screen. Read the code visually to check that MCP images reach the model.',
    inputSchema: object({}),
    annotations: readOnly,
  },
  {
    name: 'watch_screen',
    description: 'Observe the explicitly requested area of a Mac display for 2–30 seconds and return numbered, timestamped contact sheets of changed frames. Ask the user for the capture area when missing.',
    inputSchema: object({ ...selection, seconds: { ...integer(2, 30), default: 10 } }),
    annotations: readOnly,
  },
  {
    name: 'start_watch',
    description: 'Start a bounded live observation of the user-approved display area, for up to 120 seconds. Only use for an explicit request to watch in batches. Follow with next_frames and call stop_watch when finished.',
    inputSchema: object({ ...selection, seconds: { ...integer(5, 120), default: 30 } }),
    annotations: { ...readOnly, readOnlyHint: false },
  },
  {
    name: 'next_frames',
    description: 'Read the next changed contact sheet from an existing live observation, waiting up to ten seconds. Static content does not create more sheets.',
    inputSchema: object({ sessionId }, ['sessionId']),
    annotations: readOnly,
  },
  {
    name: 'stop_watch',
    description: 'Stop capture immediately and discard unread frames. Call when the user asks to stop or when live observation is no longer needed.',
    inputSchema: object({ sessionId }, ['sessionId']),
    annotations: { ...readOnly, readOnlyHint: false },
  },
];

function checkedInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function watchOptions(args, live) {
  if (process.platform !== 'darwin') throw new Error('Live screen capture requires macOS.');
  const display = checkedInteger(args.display ?? 0, 0, 15, 'display');
  const seconds = checkedInteger(args.seconds ?? (live ? 30 : 10), live ? 5 : 2, live ? 120 : 30, 'seconds');
  let region;
  if (args.region != null && args.entireDisplay !== true) {
    region = {
      x: checkedInteger(args.region.x, 0, 99, 'region.x'),
      y: checkedInteger(args.region.y, 0, 99, 'region.y'),
      width: checkedInteger(args.region.width, 1, 100, 'region.width'),
      height: checkedInteger(args.region.height, 1, 100, 'region.height'),
    };
    if (region.x + region.width > 100 || region.y + region.height > 100) {
      throw new Error('The region must fit inside the display.');
    }
    if (region.width === 100 && region.height === 100) {
      throw new Error('Use entireDisplay: true when the user explicitly selects the whole display.');
    }
  } else if (args.entireDisplay !== true || args.region != null) {
    throw new Error('Choose a region or explicitly authorize the entire display, using only one option.');
  }
  return { display, seconds, region, live };
}

const text = (value) => ({ type: 'text', text: value });
const image = (png) => ({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
const message = (value) => ({ content: [text(value)] });

function syntheticImage() {
  const width = 440;
  const height = 124;
  const rgb = Buffer.alloc(width * height * 3);
  const code = String(randomInt(100000, 1000000));
  fillRect(rgb, width, height, 0, 0, width, height, [245, 245, 245]);
  drawGlyphs(rgb, width, height, code, 30, 24, 10, [0, 0, 0]);
  return { content: [image(encodePng(rgb, width, height))] };
}

function captureResult({ sheets, remaining = 0, done, dropped, failure }) {
  if (failure) return { isError: true, ...message(failure) };
  const state = done ? 'Capture ended.' : 'Capture is still running.';
  const status = remaining ? `${state} ${remaining} more sheet(s) are buffered.` : state;
  const overflow = dropped ? ` ${dropped} older sheet(s) were discarded because the queue filled.` : '';
  if (!sheets.length) return message(`${status} No new selected frames.${overflow}`);
  const content = [text(`${status}${overflow} Times are relative to the start of capture. Frame numbers are local to each sheet.`)];
  for (const sheet of sheets) {
    const timeline = sheet.frames.map((frame, index) => `#${index + 1}  ${frame.t.toFixed(2)}s`).join(' · ');
    content.push(text(timeline), image(sheet.png));
  }
  return { content };
}

export function createTools() {
  let active;
  let reading = false;

  async function call(name, args, signal) {
    signal.throwIfAborted();
    if (name === 'vision_test') return syntheticImage();
    if (name === 'watch_screen' || name === 'start_watch') {
      if (active && !active.done) throw new Error('An observation is already running. Finish or stop it before starting another.');
      const options = watchOptions(args, name === 'start_watch');
      const session = startWatch(options);
      active = session;
      if (options.live) {
        return message(`Starting live observation for up to ${options.seconds}s. sessionId: ${session.id}. Call next_frames with this ID to retrieve the images.`);
      }
      try {
        return captureResult(await session.collect(signal));
      } finally {
        if (active === session) active = undefined;
      }
    }

    if (!active?.live || args.sessionId !== active.id) throw new Error('There is no live observation with that session ID.');
    const session = active;
    if (name === 'stop_watch') {
      await session.stop();
      if (active === session) active = undefined;
      return message('Capture stopped. Unread frames were discarded.');
    }
    if (reading) throw new Error('Wait for the current next_frames call to finish.');
    reading = true;
    try {
      return captureResult(await session.next({ signal }));
    } catch (error) {
      if (signal.aborted) await session.stop();
      throw error;
    } finally {
      reading = false;
    }
  }

  return {
    call,
    async close() { await active?.stop(); },
  };
}
