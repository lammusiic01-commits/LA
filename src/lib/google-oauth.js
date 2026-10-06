'use strict';

const http = require('node:http');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const GOOGLE_SCOPES = Object.freeze([
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
]);

function base64Url(value) { return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function makePkce() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function startGoogleOAuth({ clientId, clientSecret = '', openExternal, signal, timeoutMs = 5 * 60_000 }) {
  const id = String(clientId || '').trim();
  if (!id || id.length > 500 || !id.endsWith('.apps.googleusercontent.com')) throw new Error('Укажите OAuth Client ID типа Desktop app из Google Cloud Console.');
  const pkce = makePkce();
  const state = base64Url(randomBytes(32));
  const server = http.createServer();
  let settled = false;
  let timer;
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (server.listening) server.close();
  };
  const onAbort = () => finish(signal.reason || new Error('Подключение Google отменено.'));
  let finish;
  const resultPromise = new Promise((resolve, reject) => {
    finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
  });
  server.on('request', async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${server.address()?.port || 0}`);
    if (url.pathname !== '/oauth2callback') { response.writeHead(404).end('Not found'); return; }
    if (!safeEqual(url.searchParams.get('state'), state)) { response.writeHead(400).end('Invalid OAuth state.'); finish(new Error('Google вернул неверный OAuth state.')); return; }
    const oauthError = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (oauthError || !code) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Авторизация Google отменена. Вернитесь в Localis.');
      finish(new Error(`Google OAuth: ${oauthError || 'код авторизации не получен'}.`));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><meta charset="utf-8"><title>Localis</title><p style="font:18px system-ui">Google подключён. Вернитесь в Localis и закройте это окно.</p>');
    try {
      const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
      const form = new URLSearchParams({ client_id: id, code, code_verifier: pkce.verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' });
      if (clientSecret) form.set('client_secret', String(clientSecret).slice(0, 500));
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
      const raw = await tokenResponse.text();
      let token;
      try { token = JSON.parse(raw); } catch { throw new Error('Google OAuth вернул некорректный JSON.'); }
      if (!tokenResponse.ok || !token.access_token) throw new Error(`Обмен Google OAuth-кода не выполнен: ${String(token.error_description || token.error || raw).slice(0, 500)}`);
      const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { redirect: 'error', headers: { authorization: `Bearer ${token.access_token}` } });
      const profile = profileResponse.ok ? await profileResponse.json() : {};
      finish(null, { clientId: id, clientSecret: String(clientSecret || ''), accessToken: token.access_token, refreshToken: token.refresh_token || '', expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000, email: String(profile.email || ''), name: String(profile.name || ''), scopes: token.scope || GOOGLE_SCOPES.join(' '), connectedAt: new Date().toISOString() });
    } catch (error) { finish(error); }
  });
  server.on('error', (error) => finish(new Error(`Не удалось открыть локальный OAuth callback: ${error.message}`)));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  timer = setTimeout(() => finish(new Error('Окно авторизации Google не завершилось за 5 минут.')), timeoutMs);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({ client_id: id, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: pkce.challenge, code_challenge_method: 'S256' })) authUrl.searchParams.set(key, value);
  try { await openExternal(authUrl.href); }
  catch (error) { finish(new Error(`Не удалось открыть браузер для Google OAuth: ${error.message}`)); }
  return resultPromise;
}

module.exports = { GOOGLE_SCOPES, makePkce, safeEqual, startGoogleOAuth };
