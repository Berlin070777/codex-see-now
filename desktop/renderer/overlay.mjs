import { conversationEvent, updateState } from './conversation.mjs';

const api = window.seeNow;
api.listen(conversationEvent);
void api.info().then(({ state }) => updateState(state));
document.querySelector('#dashboard').onclick = () => api.showMain();
document.querySelector('#hide').onclick = () => api.overlay('hide');
document.querySelector('#stop').onclick = () => api.stop();
