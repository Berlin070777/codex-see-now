export function transcriptionUrl(value) {
  const url = new URL(String(value).trim());
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS transcription service or a local HTTP endpoint.');
  }
  return url.href.replace(/\/$/, '') + '/audio/transcriptions';
}

export async function transcribe({ url, model, key }, { bytes, mimeType }, signal) {
  const form = new FormData();
  const wav = mimeType.startsWith('audio/wav');
  form.set('file', new Blob([bytes], { type: wav ? 'audio/wav' : 'audio/webm' }), wav ? 'audio.wav' : 'audio.webm');
  form.set('model', model);
  const response = await fetch(url, {
    method: 'POST', body: form, redirect: 'error',
    headers: key ? { Authorization: 'Bearer ' + key } : {},
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok) throw new Error(`Audio transcription failed (HTTP ${response.status}).`);
  const result = await response.json();
  if (typeof result.text !== 'string') throw new Error('The transcription service did not return text.');
  return result.text.trim().slice(0, 2500);
}
