import { conversationEvent, report, updateState } from './conversation.mjs';

const $ = (id) => document.getElementById(id);
const api = window.seeNow;
const video = $('video');
const preview = $('selection');
const previewContext = preview.getContext('2d');
const frameCanvas = document.createElement('canvas');
const frameContext = frameCanvas.getContext('2d', { willReadFrequently: true });
const sources = new Map();
let quality;
let selected;
let region;
let dragging;
let image;
let active;
let starting = false;
let ended = false;
let playUrl;
let accountState;
let authBusy = false;
let spoken = false;

const controls = ['kind', 'source', 'load-sources', 'camera', 'load-cameras', 'file', 'quality', 'pace',
  'batch', 'auto', 'scene', 'speech', 'audio-source', 'asr-url', 'asr-model', 'asr-key',
  'signin', 'profiles', 'local', 'signout', 'api-key', 'api', 'model'];

function updateControls() {
  for (const id of controls) $(id).disabled = Boolean(active || starting || authBusy);
  $('start').disabled = Boolean(active || starting || authBusy);
  $('stop').disabled = !active;
  $('signout').disabled ||= !accountState || accountState.mode === 'local';
  $('reset-region').disabled = !region || Boolean(active || starting);
}

function run(task) {
  return async (event) => {
    event?.preventDefault();
    report('');
    try { await task(); } catch (error) { report(error.message); }
  };
}

function replaceOptions(select, rows, placeholder) {
  select.replaceChildren(new Option(placeholder, ''), ...rows.map(({ id, name }) => new Option(name, id)));
}

function displayMode() {
  const kind = $('kind').value;
  $('display-picker').hidden = kind !== 'display';
  $('camera-picker').hidden = kind !== 'camera';
  $('file-picker').hidden = kind !== 'file';
  preview.hidden = true;
  video.hidden = true;
  $('empty-preview').hidden = false;
  selected = undefined;
  region = undefined;
  image = undefined;
  if (kind === 'display') void selectSource();
  else if (kind === 'file') showFile();
  if (kind !== 'file' && playUrl) {
    video.pause();
    video.removeAttribute('src');
    URL.revokeObjectURL(playUrl);
    playUrl = undefined;
  }
  updateRange();
}

function updateRange() {
  const kind = $('kind').value;
  if (region) {
    $('range').textContent = `选区 · 左 ${Math.round(region.x * 100)}% · 上 ${Math.round(region.y * 100)}% · 宽 ${Math.round(region.width * 100)}% · 高 ${Math.round(region.height * 100)}%`;
  } else {
    $('range').textContent = selected?.name ?? (kind === 'file' ? $('file').files[0]?.name : null) ??
      (kind === 'camera' ? '使用所选摄像头的完整画面' : '尚未选择采集源');
  }
  updateControls();
}

async function selectSource() {
  const item = sources.get($('source').value);
  selected = item;
  region = undefined;
  image = undefined;
  updateRange();
  preview.hidden = true;
  $('empty-preview').hidden = false;
  if (!item?.thumbnail) return;
  const next = new Image();
  next.src = item.thumbnail;
  await next.decode();
  if (selected !== item) return;
  image = next;
  preview.width = image.naturalWidth;
  preview.height = image.naturalHeight;
  preview.hidden = false;
  $('empty-preview').hidden = true;
  drawSelection();
}

function drawSelection() {
  if (!image) return;
  previewContext.drawImage(image, 0, 0);
  if (region) {
    previewContext.fillStyle = '#07150aa0';
    previewContext.fillRect(0, 0, preview.width, preview.height);
    const x = region.x * preview.width, y = region.y * preview.height;
    const w = region.width * preview.width, h = region.height * preview.height;
    if (w > 0 && h > 0) previewContext.drawImage(image, x, y, w, h, x, y, w, h);
    previewContext.strokeStyle = '#d4ffa2';
    previewContext.lineWidth = 2;
    previewContext.strokeRect(x, y, w, h);
  }
}

function point(event) {
  const { x, y, width, height } = preview.getBoundingClientRect();
  const clamp = (value) => Math.min(1, Math.max(0, value));
  return { x: clamp((event.clientX - x) / width), y: clamp((event.clientY - y) / height) };
}

preview.addEventListener('pointerdown', (event) => {
  if (active || starting || !image) return;
  dragging = point(event);
  preview.setPointerCapture(event.pointerId);
});
preview.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const next = point(event);
  region = {
    x: Math.min(dragging.x, next.x), y: Math.min(dragging.y, next.y),
    width: Math.abs(next.x - dragging.x), height: Math.abs(next.y - dragging.y),
  };
  drawSelection();
  updateRange();
});
for (const type of ['pointerup', 'pointercancel']) preview.addEventListener(type, () => {
  dragging = undefined;
  if (region && (region.width < .02 || region.height < .02)) region = undefined;
  drawSelection();
  updateRange();
});

function showFile() {
  const file = $('file').files[0];
  if (playUrl) URL.revokeObjectURL(playUrl);
  video.srcObject = null;
  if (!file) {
    video.removeAttribute('src');
    video.hidden = true;
    $('empty-preview').hidden = false;
    return;
  }
  playUrl = URL.createObjectURL(file);
  video.src = playUrl;
  video.controls = true;
  video.hidden = false;
  $('empty-preview').hidden = true;
  video.muted = false;
  updateRange();
}

function inputTime(current) {
  if (current.kind !== 'file') return (performance.now() - current.started) / 1000;
  const time = video.currentTime;
  // Keep output monotonic across a seek while preserving normal media timestamps.
  if (time < current.lastMediaTime - .1) current.offset += current.lastMediaTime - time + .125;
  current.lastMediaTime = time;
  return current.offset + time;
}

function captureFrame(current) {
  if (active !== current || video.readyState < 2 || video.videoWidth === 0 || ended) return;
  const crop = current.region ?? { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.ceil(crop.x * video.videoWidth);
  const y = Math.ceil(crop.y * video.videoHeight);
  const w = Math.floor((crop.x + crop.width) * video.videoWidth) - x;
  const h = Math.floor((crop.y + crop.height) * video.videoHeight) - y;
  if (w < 2 || h < 2) return;
  const scale = quality[current.quality] / Math.max(w, h);
  const width = Math.max(2, Math.round(w * scale));
  const height = Math.max(2, Math.round(h * scale));
  if (frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas.width = width;
    frameCanvas.height = height;
  }
  frameContext.drawImage(video, x, y, w, h, 0, 0, width, height);
  const rgba = frameContext.getImageData(0, 0, width, height).data;
  const bytes = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4) {
    bytes[j++] = rgba[i]; bytes[j++] = rgba[i + 1]; bytes[j++] = rgba[i + 2];
  }
  api.frame({ bytes, width, height, t: inputTime(current) });
}

function recordAudio(current, track) {
  if (!track || track.readyState !== 'live') {
    report('这个来源没有可用的音轨。屏幕观察仍在继续。');
    return;
  }
  const stream = new MediaStream([track]);
  const context = new AudioContext();
  current.audioContext = context;
  const analyser = context.createAnalyser();
  context.createMediaStreamSource(stream).connect(analyser);
  const levels = new Float32Array(analyser.fftSize);
  let audible = false;
  let contaminated = false;
  let startedAt = inputTime(current);
  const startChunk = () => {
    if (active !== current || ended) return;
    audible = false;
    contaminated = false;
    startedAt = inputTime(current);
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
    current.recorder = recorder;
    recorder.ondataavailable = async ({ data }) => {
      const from = startedAt;
      const to = inputTime(current);
      if (!audible || contaminated || active !== current || !data.size) return;
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (active === current) api.audio({ bytes, mimeType: data.type, from, to });
    };
    recorder.onstop = startChunk;
    recorder.start();
  };
  startChunk();
  current.audioMeter = setInterval(() => {
    analyser.getFloatTimeDomainData(levels);
    const rms = Math.sqrt(levels.reduce((sum, value) => sum + value * value, 0) / levels.length);
    audible ||= rms > .008;
    contaminated ||= spoken;
    api.level(Math.max(-72, 20 * Math.log10(rms)));
  }, 125);
  current.audioTimer = setInterval(() => {
    if (current.recorder?.state === 'recording') current.recorder.stop();
  }, 6000);
}

async function begin() {
  if (starting || active) return;
  const kind = $('kind').value;
  if (kind === 'display' && !selected) throw new Error('请先加载并选择屏幕或窗口。');
  if (kind === 'file' && !$('file').files[0]) throw new Error('请先选择一个本地视频。');
  const audioSource = $('audio-source').value;
  const audio = audioSource ? {
    source: audioSource, url: $('asr-url').value || 'http://127.0.0.1:8000/v1',
    model: $('asr-model').value, key: $('asr-key').value,
  } : null;
  const options = {
    kind, sourceId: selected?.id, region, quality: $('quality').value, pace: $('pace').value,
    batch: Number($('batch').value), automatic: $('auto').checked, scene: $('scene').checked,
    speech: $('speech').checked, model: $('model').value, audio,
  };
  starting = true;
  updateControls();
  try {
    await api.start(options);
    ended = false;
    const current = { kind, region, quality: options.quality, started: performance.now(), lastMediaTime: 0, offset: 0 };
    active = current;
    $('asr-key').value = '';
    if (kind === 'display') {
      current.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: audioSource === 'source' });
    } else if (kind === 'camera') {
      const deviceId = $('camera').value;
      current.stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: audioSource === 'source' ? { echoCancellation: true } : false,
      });
    }
    if (active !== current) {
      current.stream?.getTracks().forEach((track) => track.stop());
      return;
    }
    if (kind !== 'file') {
      video.removeAttribute('src');
      video.srcObject = current.stream;
      video.controls = false;
      video.muted = true;
      current.stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (active === current) void api.stop();
      });
    } else {
      video.currentTime = 0;
    }
    await video.play();
    if (active !== current) return;
    current.started = performance.now();
    $('empty-preview').hidden = true;
    preview.hidden = true;
    video.hidden = kind === 'display';
    if (kind === 'display') preview.hidden = !image;
    await api.captureReady();
    current.timer = setInterval(() => captureFrame(current), 125);
    if (audio) {
      try {
        if (audioSource === 'mic') current.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
        else if (kind === 'file') current.audioStream = video.captureStream();
        const track = (current.mic ?? current.audioStream ?? current.stream)?.getAudioTracks()[0];
        if (active === current) recordAudio(current, track);
        else current.mic?.getTracks().forEach((track) => track.stop());
      } catch (error) {
        report('无法开启音频转写：' + error.message);
      }
    }
  } catch (error) {
    if (active) await api.stop();
    cleanup();
    throw error;
  } finally {
    starting = false;
    updateControls();
  }
}

function cleanup() {
  const current = active;
  active = undefined;
  if (current) {
    for (const timer of [current.timer, current.audioTimer, current.audioMeter]) clearInterval(timer);
    if (current.recorder?.state === 'recording') current.recorder.stop();
    for (const stream of [current.stream, current.mic, current.audioStream]) stream?.getTracks().forEach((track) => track.stop());
    void current.audioContext?.close().catch(() => {});
  }
  video.pause();
  video.srcObject = null;
  speechSynthesis.cancel();
  spoken = false;
  void api.speaking(false);
  if ($('kind').value === 'file') showFile();
  else if (selected) {
    preview.hidden = !image;
    video.hidden = true;
  } else {
    video.hidden = true;
    $('empty-preview').hidden = false;
  }
  updateControls();
}

async function refreshAccount(status) {
  const oldMode = accountState?.mode;
  accountState = status ?? await api.account();
  if (oldMode && oldMode !== accountState.mode) $('model').value = '';
  const selectedProfile = accountState.profiles.find(({ id }) => id === accountState.selected);
  $('account-status').textContent = accountState.mode === 'plan'
    ? `${selectedProfile?.email ?? 'ChatGPT'} · 使用 ChatGPT 套餐`
    : accountState.mode === 'api' ? 'OpenAI Platform · 按 API 用量计费' : '使用本机 Codex 已保存的登录';
  replaceOptions($('profiles'), accountState.profiles.map(({ id, email, connected }, index) => ({
    id, name: `${email} · ${index + 1}${connected ? '' : ' · 需重新授权'}`,
  })), '选择已保存账号');
  $('profiles').value = accountState.selected ?? '';
  $('models').replaceChildren();
  if (accountState.mode === 'plan') {
    const models = await api.models();
    $('models').replaceChildren(...models.map(({ id, name }) => new Option(name, id)));
    if (models.length && !models.some(({ id }) => id === $('model').value)) $('model').value = models[0].id;
  }
  if (accountState.warning) report(accountState.warning);
  updateControls();
}

function accountAction(action) {
  return run(async () => {
    if (authBusy) return;
    authBusy = true;
    updateControls();
    try { await refreshAccount(await action()); }
    finally { authBusy = false; updateControls(); }
  });
}

$('kind').onchange = displayMode;
$('file').onchange = showFile;
$('source').onchange = run(selectSource);
$('load-sources').onclick = run(async () => {
  const items = await api.sources();
  sources.clear();
  for (const item of items) sources.set(item.id, item);
  replaceOptions($('source'), items, '请选择屏幕或窗口');
  if (!items.length) throw new Error('未找到可采集的屏幕或窗口。检查系统录屏权限。');
});
$('load-cameras').onclick = run(async () => {
  const items = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === 'videoinput');
  replaceOptions($('camera'), items.map(({ deviceId, label }, i) => ({ id: deviceId, name: label || `摄像头 ${i + 1}` })), '默认摄像头');
});
$('reset-region').onclick = () => { region = undefined; drawSelection(); updateRange(); };
$('start').onclick = run(begin);
$('stop').onclick = run(() => api.stop());
$('show-overlay').onclick = run(() => api.overlay('show'));
$('signin').onclick = accountAction(() => api.signIn());
$('local').onclick = accountAction(() => api.chooseAuth('local'));
$('api').onclick = accountAction(async () => {
  const result = await api.chooseAuth('api', $('api-key').value);
  $('api-key').value = '';
  return result;
});
$('profiles').onchange = accountAction(() => {
  const profile = accountState.profiles.find(({ id }) => id === $('profiles').value);
  return !profile ? accountState : profile.connected ? api.chooseAuth('plan', profile.id) : api.signIn(profile.id);
});
$('signout').onclick = accountAction(() => api.signOut());
$('usage').onclick = run(() => api.usage());
video.addEventListener('ended', () => {
  if (active?.kind !== 'file') return;
  ended = true;
  if (active.recorder?.state === 'recording') active.recorder.stop();
  void api.finish();
});
video.addEventListener('error', () => {
  if ($('kind').value === 'file') report('无法播放此视频。请使用此系统支持的 MP4 或 WebM 编码。');
});

api.listen((event) => {
  const { type, data } = event;
  conversationEvent(event);
  if (type === 'capture-stop') cleanup();
  if (type === 'state') {
    $('queue').textContent = data.queued ? `${data.queued} 张待发送` : '';
    $('stats').textContent = `已采样 ${data.frames ?? 0} 帧 · 保留 ${data.retained ?? 0} 帧 · 溢出丢弃 ${data.dropped ?? 0} 张拼图`;
  }
  if (type === 'sheet') {
    const labels = { first: '参考帧', cut: '场景切换', mark: '运动变化', user: '手动观察', floor: '间隔采样' };
    $('reasons').textContent = data.reasons.map((reason, index) => `#${index + 1} ${labels[reason] ?? reason}`).join(' · ');
    $('sheet').src = data.url;
    $('sheet').hidden = false;
    $('empty-sheet').hidden = true;
    $('timeline').textContent = data.times.map((t, i) => `#${i + 1} ${t.toFixed(1)}s`).join(' · ');
  }
  if (type === 'speech-active') spoken = Boolean(data);
  if (type === 'speak' && data) {
    const utterance = new SpeechSynthesisUtterance(data.slice(0, 500));
    const setSpeaking = (value) => { spoken = value; void api.speaking(value); };
    utterance.lang = /[\u3400-\u9fff]/u.test(data) ? 'zh-CN' : 'en-US';
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = utterance.onerror = () => setSpeaking(false);
    speechSynthesis.speak(utterance);
  }
});

void api.info().then((info) => { quality = info.quality; updateState(info.state); }).catch((error) => report(error.message));
void refreshAccount().catch((error) => report(error.message));
