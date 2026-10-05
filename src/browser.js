'use strict';

const addressInput = document.getElementById('address');
const stateBar = document.getElementById('page-state');
const stateLabel = document.getElementById('state-label');

function normalizeAddress(value) {
  const text = value.trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w-]+\.[a-z]{2,}(?:\/|$)/i.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

function setState(state) {
  const url = state.url || '';
  if (url) addressInput.value = url;
  stateBar.classList.toggle('loading', Boolean(state.loading));
  stateBar.classList.toggle('error', Boolean(state.error));
  stateLabel.textContent = state.error ? `Не удалось открыть страницу: ${state.error}` : state.loading ? 'Загрузка страницы…' : (state.title || url || 'Готово');
}

document.getElementById('address-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = normalizeAddress(addressInput.value);
  if (url) await window.localisBrowser.navigate(url);
});
document.getElementById('back').addEventListener('click', () => window.localisBrowser.back());
document.getElementById('forward').addEventListener('click', () => window.localisBrowser.forward());
document.getElementById('reload').addEventListener('click', () => window.localisBrowser.reload());
document.getElementById('search').addEventListener('click', () => {
  addressInput.value = 'https://duckduckgo.com';
  window.localisBrowser.navigate(addressInput.value);
});
document.getElementById('external').addEventListener('click', () => window.localisBrowser.openExternal());
window.localisBrowser.onState(setState);
