import { app, BrowserWindow, desktopCapturer, Menu, nativeImage, safeStorage, screen, session, shell, systemPreferences, Tray, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Accounts } from './core/auth.mjs';
import { Conversation, listCodexModels } from './core/codex.mjs';
import { Observer, PACES, QUALITY } from './core/observer.mjs';
import { transcribe, transcriptionUrl } from './core/transcribe.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
let dashboard;
let companion;
let tray;
let accounts;
let cwd;
let observation;
let sources = new Map();
let quitting = false;
let lastState = {};
let speaking = false;
let speechProcess;
let starting = false;
let startEpoch = 0;
const smoke = process.argv.includes('--ui-smoke');
const supportsSystemPicker = process.platform === 'darwin' && Number(process.getSystemVersion().split('.')[0]) >= 15;
let systemPickerOwner;
const icon = nativeImage.createFromPath(join(here, 'assets', 'tray.png'));

app.setName('See Now');
if (smoke && process.env.SEE_NOW_SMOKE_USER_DATA) app.setPath('userData', process.env.SEE_NOW_SMOKE_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showDashboard());
  app.on('activate', () => showDashboard());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void stop().finally(() => app.quit());
  });
  app.on('window-all-closed', () => {});
  app.whenReady().then(initialize).catch((error) => {
    console.error(error.message);
    app.exit(1);
  });
}

function makeWindow(page, options) {
  const window = new BrowserWindow({
    show: false, backgroundColor: '#101514',
    ...options,
    webPreferences: {
      preload: join(here, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.setContentProtection(true);
  void window.loadFile(join(here, 'renderer', page));
  return window;
}

function alive(window) {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed());
}

function watchBounds(window) {
  for (const event of ['hide', 'show', 'minimize', 'restore', 'move', 'resize']) window.on(event, enforceCaptureBounds);
}

function dashboardWindow() {
  if (alive(dashboard)) return dashboard;
  const window = makeWindow('index.html', { title: 'See Now · Dashboard', width: 1020, height: 760, minWidth: 720, minHeight: 580 });
  dashboard = window;
  watchBounds(window);
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
      if (!observation && !starting) send(window, { type: 'stop-window-preview' });
    }
  });
  window.on('closed', () => {
    if (dashboard !== window) return;
    dashboard = undefined;
    if (!quitting) {
      if (systemPickerOwner) setSystemPicker(false);
      void stop();
    }
  });
  return window;
}

function companionWindow() {
  if (alive(companion)) return companion;
  const window = makeWindow('overlay.html', {
    title: 'See Now · Companion', width: 390, height: 300, minWidth: 300, minHeight: 240,
    alwaysOnTop: true, skipTaskbar: true, titleBarStyle: 'hidden',
  });
  companion = window;
  watchBounds(window);
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
      void stop();
    }
  });
  window.on('closed', () => {
    if (companion === window) companion = undefined;
    if (!quitting) enforceCaptureBounds();
  });
  return window;
}

function showDashboard() {
  if (quitting || !accounts || !app.isReady()) return;
  const window = dashboardWindow();
  window.show();
  if (alive(window)) window.focus();
  enforceCaptureBounds();
}

function send(window, payload) {
  if (alive(window)) window.webContents.send('see:event', payload);
}

function broadcast(type, data) {
  for (const window of [dashboard, companion]) send(window, { type, data });
}

function state(status, extra = {}) {
  lastState = { ...lastState, ...extra, status };
  broadcast('state', lastState);
  tray?.setToolTip(status === 'observing' ? 'See Now • Observing' : 'See Now');
}

function safeOverlayPlacement() {
  if (!observation || observation.kind !== 'display' || observation.systemWindow || observation.source?.id.startsWith('window:')) return true;
  const selected = screen.getAllDisplays().find(({ id }) => String(id) === observation.source?.display_id);
  if (!selected) return false;
  const region = observation.region ?? { x: 0, y: 0, width: 1, height: 1 };
  const { x, y, width, height } = selected.bounds;
  const capture = {
    left: x + region.x * width, top: y + region.y * height,
    right: x + (region.x + region.width) * width, bottom: y + (region.y + region.height) * height,
  };
  if (!alive(companion)) return false;
  const [w, h] = companion.getSize();
  for (const { workArea: area } of screen.getAllDisplays()) {
    const corners = [[area.x + 10, area.y + 10], [area.x + area.width - w - 10, area.y + 10],
      [area.x + 10, area.y + area.height - h - 10], [area.x + area.width - w - 10, area.y + area.height - h - 10]];
    if (area.width < w + 20 || area.height < h + 20) continue;
    for (const [left, top] of corners) {
      if (left + w <= capture.left || left >= capture.right || top + h <= capture.top || top >= capture.bottom) {
        companion.setPosition(left, top);
        return true;
      }
    }
  }
  return false;
}

function overlapsDisplay(window, active) {
  if (!alive(window) || !window.isVisible() || window.isMinimized()) return false;
  const display = screen.getAllDisplays().find(({ id }) => String(id) === active.source.display_id);
  if (!display) return true;
  const { x, y, width, height } = display.bounds;
  const region = active.region ?? { x: 0, y: 0, width: 1, height: 1 };
  const windowBounds = window.getBounds();
  const left = x + region.x * width;
  const top = y + region.y * height;
  return windowBounds.x < left + region.width * width && windowBounds.x + windowBounds.width > left &&
    windowBounds.y < top + region.height * height && windowBounds.y + windowBounds.height > top;
}

function enforceCaptureBounds() {
  if (!observation || observation.kind !== 'display' || !observation.source?.id.startsWith('screen:')) return;
  const paused = overlapsDisplay(dashboard, observation) || overlapsDisplay(companion, observation);
  if (observation.engine.state.paused !== paused) observation.engine.pause(paused);
}

function showCompanion() {
  if (quitting || !accounts || !app.isReady()) return;
  const window = companionWindow();
  safeOverlayPlacement();
  window.showInactive();
  enforceCaptureBounds();
}

function confirmSource(event) {
  const owner = [dashboard, companion].find((window) => alive(window) && window.webContents === event.sender);
  if (!owner || event.senderFrame !== owner.webContents.mainFrame) throw new Error('Invalid See Now request origin.');
}

function handler(name, fn) {
  ipcMain.handle('see:' + name, async (event, ...args) => {
    if (quitting) return;
    confirmSource(event);
    return fn(...args);
  });
}

function validateRegion(region) {
  if (region == null) return null;
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < .02 || height < .02 ||
      x + width > 1.000001 || y + height > 1.000001) throw new Error('Select a valid capture region.');
  return { x, y, width, height };
}

function setSystemPicker(enabled) {
  const ses = session.defaultSession;
  systemPickerOwner = enabled ? dashboard : undefined;
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (enabled || !observation?.source || !observation.mediaReady || !alive(dashboard) || request.frame !== dashboard.webContents.mainFrame) {
      callback({});
      return;
    }
    observation.mediaReady = false;
    callback({ video: observation.source, ...(observation.loopback && request.audioRequested ? { audio: 'loopback' } : {}) });
  }, { useSystemPicker: enabled });
}

function registerMedia() {
  const ses = session.defaultSession;
  const permitted = (contents, permission) =>
    alive(dashboard) && contents === dashboard.webContents && ['media', 'display-capture'].includes(permission);
  ses.setPermissionCheckHandler(permitted);
  ses.setPermissionRequestHandler((contents, permission, callback) => callback(permitted(contents, permission)));
  setSystemPicker(false);
}

async function listSources() {
  let items;
  let issue;
  try {
    items = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 640, height: 400 } });
  } catch {
    const permission = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : null;
    if (permission && permission !== 'granted' && permission !== 'unknown') {
      sources.clear();
      return { items: [], issue: 'permission' };
    }
    // A failure to enumerate one source type or produce a thumbnail should not block the other type.
    items = [];
    for (const type of ['window', 'screen']) {
      try {
        items.push(...await desktopCapturer.getSources({ types: [type], thumbnailSize: { width: 0, height: 0 } }));
      } catch {
        issue = 'unavailable';
      }
    }
    if (items.length) issue = 'no-preview';
  }
  const own = new Set([dashboard, companion].filter(alive)
    .map((window) => window.getMediaSourceId().split(':').slice(0, 2).join(':')));
  sources = new Map(items.filter((item) => !own.has(item.id.split(':').slice(0, 2).join(':'))).map((item) => [item.id, item]));
  return {
    items: [...sources.values()].map((item) => ({
      id: item.id, name: item.name, thumbnail: item.thumbnail.isEmpty() ? null : item.thumbnail.toDataURL(),
    })),
    issue,
  };
}

async function start(options) {
  if (observation || starting) throw new Error('Stop the current observation first.');
  if (!['display', 'camera', 'file'].includes(options.kind)) throw new Error('Choose a capture source.');
  const systemWindow = options.kind === 'display' && options.systemWindow === true && supportsSystemPicker;
  const source = options.kind === 'display' && !systemWindow ? sources.get(options.sourceId) : null;
  if (options.kind === 'display' && !source && !systemWindow) throw new Error('Choose a screen or window first.');
  const region = validateRegion(options.region);
  const audio = options.audio ? {
    url: transcriptionUrl(options.audio.url),
    model: String(options.audio.model).trim().slice(0, 100),
    key: String(options.audio.key ?? '').trim(),
  } : null;
  if (audio && !audio.model) throw new Error('Enter the transcription model.');
  const model = modelId(options.model);
  starting = true;
  const epoch = ++startEpoch;
  const conversation = new Conversation({ cwd, model, credentials: () => accounts.getCredentials() });
  try {
    await conversation.verify();
    if (quitting || epoch !== startEpoch) throw new Error('Observation stopped.');
  } catch (error) {
    await conversation.stop();
    throw error;
  } finally {
    starting = false;
  }

  const engine = new Observer({
    conversation, ...options,
    encode(sheet) {
      if (sheet.png.length < 800000) return sheet;
      const image = nativeImage.createFromBuffer(sheet.png).toJPEG(89);
      return image.length ? { ...sheet, image, mimeType: 'image/jpeg' } : sheet;
    },
  });
  const active = {
    engine, kind: options.kind, source, systemWindow, region, audio,
    loopback: options.audio?.source === 'source',
    mediaReady: true,
    controller: new AbortController(),
    speech: Boolean(options.speech),
  };
  observation = active;
  let latestMessage = '';
  conversation.on('turn', (_text, modelInUse) => {
    latestMessage = '';
    broadcast('turn');
    broadcast('model-in-use', { id: modelInUse });
  });
  conversation.on('rerouted', (id, from) => broadcast('model-in-use', { id, from }));
  conversation.on('delta', (delta) => broadcast('delta', delta));
  conversation.on('message', (message, phase) => {
    if (phase !== 'commentary') latestMessage = message;
  });
  let previousBusy = false;
  engine.on('state', (value) => {
    if (observation !== active) return;
    const ended = previousBusy && !value.busy;
    previousBusy = value.busy;
    if (ended) {
      const final = latestMessage.trim() === 'SKIP' ? '' : latestMessage;
      broadcast('answer', final);
      if (final && active.speech) speak(final);
    }
    state(value.paused ? 'paused' : value.ended ? 'ended' : 'observing', value);
  });
  engine.on('sheet', (sheet) => broadcast('sheet', {
    url: 'data:image/png;base64,' + sheet.png.toString('base64'),
    times: sheet.frames.map(({ t }) => t),
    reasons: sheet.frames.map(({ via }) => via),
  }));
  engine.on('question', (text) => broadcast('question', text));
  engine.on('transcript', (line) => broadcast('transcript', line));
  engine.on('problem', (message) => broadcast('error', message));
  state('observing', engine.state);
  return { quality: Object.hasOwn(QUALITY, options.quality) ? options.quality : 'low' };
}

async function stop() {
  startEpoch++;
  if (!observation) {
    if (alive(dashboard)) send(dashboard, { type: 'stop-window-preview' });
    return;
  }
  const active = observation;
  observation = undefined;
  active.controller.abort();
  speechProcess?.kill();
  speechProcess = undefined;
  speaking = false;
  broadcast('capture-stop');
  state('idle', { busy: false, queued: 0, seconds: 0, frames: 0, retained: 0, dropped: 0 });
  await active.engine.stop();
}

function speak(text) {
  if (process.platform !== 'darwin') {
    send(dashboard, { type: 'speak', data: text });
    return;
  }
  speechProcess?.kill();
  const child = spawn('/usr/bin/say', ['-f', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
  speechProcess = child;
  speaking = true;
  send(dashboard, { type: 'speech-active', data: true });
  const finish = () => {
    if (speechProcess !== child) return;
    speechProcess = undefined;
    speaking = false;
    send(dashboard, { type: 'speech-active', data: false });
  };
  child.on('close', finish);
  child.on('error', finish);
  child.stdin.on('error', () => {});
  child.stdin.end(text.slice(0, 800));
}

async function handleAudio(payload) {
  const active = observation;
  if (!active?.audio || active.transcribing || active.engine.state.paused || speaking) return;
  const { bytes, mimeType, from, to } = payload ?? {};
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 2_000_000 || typeof mimeType !== 'string' ||
      (!mimeType.startsWith('audio/webm') && !mimeType.startsWith('audio/wav')) ||
      !Number.isFinite(from) || !Number.isFinite(to) || to < from) return;
  active.transcribing = true;
  try {
    const text = await transcribe(active.audio, { bytes, mimeType }, active.controller.signal);
    if (observation === active && !active.engine.state.paused) active.engine.transcript({ text, from, to });
  } catch (error) {
    if (!active.controller.signal.aborted) broadcast('error', error.message);
  } finally {
    active.transcribing = false;
  }
}

function modelId(value) {
  const id = String(value ?? '').trim();
  if (id && !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(id)) throw new Error('Enter a valid Codex model ID.');
  return id;
}

async function availableModels() {
  const { mode } = accounts.status();
  if (mode === 'local') return listCodexModels(cwd);
  const authorized = await accounts.models();
  if (mode === 'plan') return authorized;

  // Platform model lists include embeddings, audio and other non-vision models.
  const known = await listCodexModels(cwd, await accounts.getCredentials()).catch(() => []);
  const byId = new Map(known.map((model) => [model.id, model]));
  return authorized.flatMap(({ id }) => byId.has(id) ? [byId.get(id)] : []);
}

function registerHandlers() {
  handler('info', () => ({ state: lastState, paces: Object.keys(PACES), quality: QUALITY, smoke, supportsSystemPicker }));
  handler('sources', listSources);
  handler('systemPicker', (enabled) => {
    if (!supportsSystemPicker) throw new Error('The macOS window picker requires macOS 15 or later.');
    if (enabled === true && (observation || starting || systemPickerOwner)) throw new Error('Finish the current selection first.');
    setSystemPicker(enabled === true);
  });
  handler('screenSettings', () => {
    if (process.platform === 'darwin') return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });
  handler('start', start);
  handler('stop', stop);
  handler('finish', () => observation?.engine.finishSource());
  handler('question', (text, options) => observation?.engine.question(text, options));
  handler('overlay', (action) => {
    if (action === 'hide') { if (alive(companion)) companion.hide(); }
    else showCompanion();
    enforceCaptureBounds();
  });
  handler('showMain', showDashboard);
  handler('account', () => accounts.status());
  handler('models', availableModels);
  handler('setModel', (value) => observation?.engine.setModel(modelId(value)));
  handler('signIn', (profile) => {
    if (observation || starting) throw new Error('Stop observing before switching accounts.');
    return accounts.signIn(profile);
  });
  handler('chooseAuth', (mode, value) => {
    if (observation || starting) throw new Error('Stop observing before switching accounts.');
    return accounts.choose(mode, value);
  });
  handler('signOut', () => {
    if (observation || starting) throw new Error('Stop observing before switching accounts.');
    return accounts.signOut();
  });
  handler('usage', () => shell.openExternal('https://chatgpt.com/#settings/Usage'));
  handler('speaking', (value) => { speaking = value === true; });
  handler('captureReady', () => {
    if (!observation) return;
    if (observation.kind === 'display') {
      if (alive(dashboard)) dashboard.hide();
      const window = companionWindow();
      if (safeOverlayPlacement()) window.showInactive();
      else window.hide();
      enforceCaptureBounds();
    }
  });
  ipcMain.on('see:frame', (event, payload) => {
    if (alive(dashboard) && event.sender === dashboard.webContents) observation?.engine.frame(payload ?? {});
  });
  ipcMain.on('see:level', (event, db) => {
    if (alive(dashboard) && event.sender === dashboard.webContents && !speaking) observation?.engine.audioLevel(db);
  });
  ipcMain.on('see:audio', (event, payload) => {
    if (alive(dashboard) && event.sender === dashboard.webContents) void handleAudio(payload);
  });
}

async function initialize() {
  const data = app.getPath('userData');
  cwd = join(data, 'workspace');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  accounts = new Accounts({ directory: data, storage: safeStorage, openBrowser: shell.openExternal });
  await accounts.load();
  if (quitting) return;
  dashboardWindow();
  companionWindow();
  registerMedia();
  registerHandlers();
  if (!icon.isEmpty()) {
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'See Now', click: showDashboard },
      { label: 'Show companion', click: showCompanion },
      { label: 'Stop observation', click: () => void stop() },
      { type: 'separator' }, { role: 'quit' },
    ]));
  }
  state('idle');
  dashboard.once('ready-to-show', () => { if (!smoke) showDashboard(); });
  if (smoke) {
    dashboard.webContents.once('did-finish-load', async () => {
      try {
        const status = await dashboard.webContents.executeJavaScript('window.seeNow.info()');
        if (!status.smoke) throw new Error('Renderer bridge did not initialize.');
        for (let i = 0; i < 25; i++) {
          if (await dashboard.webContents.executeJavaScript('Boolean(document.querySelector("#account-status")?.textContent)')) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        const snapshot = await dashboard.webContents.executeJavaScript(
          '({title: document.querySelector("h1").textContent, status: document.querySelector("#account-status").textContent})',
        );
        if (snapshot.title !== 'See Now' || !snapshot.status) throw new Error('Dashboard modules did not initialize.');
        console.log('See Now renderer and main-process bridge initialized.');
        if (process.env.SEE_NOW_SMOKE_MODELS === '1') {
          let modelCount = 0;
          for (let i = 0; i < 50 && modelCount < 2; i++) {
            modelCount = await dashboard.webContents.executeJavaScript(
              'Array.from(document.querySelector("#model").options).filter((option) => option.value && option.value !== "__custom__").length',
            );
            if (modelCount < 2) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (modelCount < 2) throw new Error('Multiple Codex models were not listed.');
          console.log(`The dashboard listed ${modelCount} available Codex models.`);
        }
        const output = process.env.SEE_NOW_SMOKE_SCREENSHOT;
        if (output) await writeFile(output, (await dashboard.webContents.capturePage()).toPNG());
        if (process.env.SEE_NOW_SMOKE_VIDEO) await smokeVideo(process.env.SEE_NOW_SMOKE_VIDEO);
        if (process.env.SEE_NOW_SMOKE_WINDOW === '1') await smokeWindow();
        if (process.env.SEE_NOW_SMOKE_LIFECYCLE === '1') {
          const previousDashboard = dashboard;
          previousDashboard.destroy();
          app.emit('activate');
          if (!alive(dashboard) || dashboard === previousDashboard) throw new Error('Dashboard did not reopen.');
          const previousCompanion = companion;
          previousCompanion.destroy();
          showCompanion();
          if (!alive(companion) || companion === previousCompanion) throw new Error('Companion did not reopen.');
          app.on('before-quit', () => app.emit('activate'));
          console.log('Destroyed windows reopened, and activation during quit was ignored.');
        }
        app.quit();
      } catch (error) {
        console.error(error.message);
        app.exit(1);
      }
    });
  }
}


async function smokeVideo(path) {
  const base64 = (await readFile(path)).toString('base64');
  const audioUrl = process.env.SEE_NOW_SMOKE_AUDIO_URL ?? '';
  await dashboard.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#kind');
    select.value = 'file';
    select.dispatchEvent(new Event('change'));
    const file = new File([Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0))], 'fixture.mp4', {type: 'video/mp4'});
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const picker = document.querySelector('#file');
    picker.files = transfer.files;
    picker.dispatchEvent(new Event('change'));
    document.querySelector('#pace').value = 'dense';
    const audioUrl = ${JSON.stringify(audioUrl)};
    if (audioUrl) {
      document.querySelector('#audio-source').value = 'source';
      document.querySelector('#asr-url').value = audioUrl;
      document.querySelector('#asr-model').value = 'smoke-test';
    }
    document.querySelector('#start').click();
  })()`);
  await smokeResult('Video playback', Boolean(audioUrl));
}

async function smokeWindow() {
  const title = 'See Now Capture Test';
  const fixture = new BrowserWindow({
    width: 420, height: 250, title, show: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  try {
    await fixture.loadURL('data:text/html,' + encodeURIComponent(
      '<!doctype html><title>See Now Capture Test</title><body style="background:#b53336;color:white;font:40px system-ui">See Now test</body>',
    ));
    await dashboard.webContents.executeJavaScript("document.querySelector('#load-sources').click()");
    let selected = false;
    for (let i = 0; i < 30; i++) {
      selected = await dashboard.webContents.executeJavaScript(`(() => {
        const select = document.querySelector('#source');
        const option = Array.from(select.options).find((option) => option.text === ${JSON.stringify(title)});
        if (!option) return false;
        select.value = option.value;
        select.dispatchEvent(new Event('change'));
        return true;
      })()`);
      if (selected) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!selected) {
      const rendererError = await dashboard.webContents.executeJavaScript("document.querySelector('#error').textContent");
      const access = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unknown';
      throw new Error(rendererError || `The test window was not listed. Screen recording access: ${access}.`);
    }
    await dashboard.webContents.executeJavaScript("document.querySelector('#start').click()");
    const color = setInterval(() => {
      if (fixture.isDestroyed()) return;
      void fixture.webContents.executeJavaScript(
        'document.body.style.backgroundColor = document.body.style.backgroundColor === "rgb(50, 141, 104)" ? "#b53336" : "#328d68"',
      ).catch(() => {});
    }, 1700);
    try { await smokeResult('Live window capture'); }
    finally { clearInterval(color); }
  } finally {
    fixture.destroy();
  }
}

async function smokeResult(source, requireAudio = false) {
  const deadline = Date.now() + 55000;
  while (Date.now() < deadline) {
    const result = await dashboard.webContents.executeJavaScript(`({
      hasSheet: !document.querySelector('#sheet').hidden,
      answer: [...document.querySelectorAll('#messages .message:not(.transcript):not(.user)')].some((node) => node.textContent),
      transcript: document.querySelector('#messages .transcript')?.textContent,
      error: document.querySelector('#error').textContent,
    })`);
    if (result.error) throw new Error(result.error);
    if (result.hasSheet && result.answer && (!requireAudio || result.transcript) && !lastState.busy) {
      await stop();
      console.log(source + ' produced a contact sheet and a Codex reply. Observation stopped.');
      if (requireAudio) console.log('The audio clip reached the configured transcription endpoint and appeared in the timeline.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(source + ' smoke test timed out.');
}
