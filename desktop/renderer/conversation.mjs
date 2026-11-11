const api = window.seeNow;
const status = document.querySelector('#status');
const messages = document.querySelector('#messages');
const error = document.querySelector('#error');
const input = document.querySelector('#question');
let streaming;

export function report(message) {
  error.hidden = !message;
  error.textContent = message ?? '';
}

function message(text, type = '') {
  const element = document.createElement('div');
  element.className = 'message ' + type;
  element.textContent = text;
  messages.append(element);
  while (messages.childElementCount > 100) messages.firstElementChild.remove();
  messages.scrollTop = messages.scrollHeight;
  return element;
}

export function updateState(value) {
  const text = {
    idle: '待机', observing: value.busy ? 'Codex 分析中' : '观察中',
    paused: '窗口重叠 · 暂停提交', ended: '视频已播完',
  };
  status.dataset.state = value.status;
  status.textContent = text[value.status] ?? text.idle;
}

export function conversationEvent({ type, data }) {
  switch (type) {
    case 'state': updateState(data); break;
    case 'error': report(data); break;
    case 'turn': streaming = undefined; break;
    case 'delta':
      streaming ??= message('');
      streaming.textContent += data;
      messages.scrollTop = messages.scrollHeight;
      break;
    case 'answer':
      if (data) {
        streaming ??= message('');
        streaming.textContent = data;
      } else {
        streaming?.remove();
      }
      streaming = undefined;
      break;
    case 'question': message(data, 'user'); break;
    case 'transcript': message(`${data.from.toFixed(1)}s 转写 · ${data.text}`, 'transcript'); break;
  }
}

function ask(text, options) {
  return api.question(text, options).catch((error) => report(error.message));
}

document.querySelector('#question-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (input.value.trim()) void ask(input.value);
  input.value = '';
});
document.querySelector('#peek').addEventListener('click', () => void ask('请看一眼现在的画面，简要说说你看到了什么。', { peek: true }));
