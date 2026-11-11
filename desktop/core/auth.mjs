import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ISSUER = 'https://auth.openai.com';
const API = 'https://api.openai.com/v1';
const TOKEN_URL = ISSUER + '/api/accounts/oauth/token';
const CALLBACK = '/auth/callback';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = 'openid profile email offline_access resource.invoke ' + PLAN_SCOPE;
const nonceValue = () => randomBytes(32).toString('base64url');

async function fetchJson(url, options) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error', ...options });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const code = typeof detail.error === 'string' && /^[a-z_]+$/.test(detail.error) ? ` ${detail.error}` : '';
    throw new Error(`OpenAI returned HTTP ${res.status}.${code}`);
  }
  return res.json();
}

function exchange(params) {
  return fetchJson(TOKEN_URL, { method: 'POST', body: new URLSearchParams({ ...params, resource: API }) });
}

async function verifiedIdentity(jwt, clientId, nonce) {
  const parts = typeof jwt === 'string' ? jwt.split('.') : [];
  if (parts.length !== 3) throw new Error('The sign-in did not return a verifiable identity.');
  const [head, body, signature] = parts;
  const header = JSON.parse(Buffer.from(head, 'base64url'));
  const payload = JSON.parse(Buffer.from(body, 'base64url'));
  const jwks = await fetchJson(ISSUER + '/.well-known/jwks.json');
  const jwk = jwks.keys.find((key) => key.kid === header.kid && key.kty === 'RSA');
  if (header.alg !== 'RS256' || !jwk ||
      !verify('RSA-SHA256', Buffer.from(head + '.' + body), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
    throw new Error('OpenAI ID token signature verification failed.');
  }
  const now = Date.now() / 1000;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== ISSUER || !audiences.includes(clientId) ||
      ((audiences.length > 1 || payload.azp !== undefined) && payload.azp !== clientId) ||
      !Number.isFinite(payload.exp) || payload.exp <= now || (payload.nbf ?? 0) > now + 30 ||
      payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('OpenAI ID token claims did not match the pending authorization.');
  }
  return payload;
}

function credentials(response, previous = {}) {
  const expires = Number(response.expires_in);
  const scopes = response.scope === undefined ? previous.scopes : String(response.scope).split(/\s+/);
  if (typeof response.access_token !== 'string' || !response.access_token ||
      !Number.isFinite(expires) || expires <= 0 || !scopes?.includes(PLAN_SCOPE)) {
    throw new Error('ChatGPT plan usage was not granted. Approve plan usage or choose an API key.');
  }
  return {
    ...previous,
    token: response.access_token,
    refreshToken: response.refresh_token ?? previous.refreshToken,
    idToken: response.id_token ?? previous.idToken,
    scopes,
    expiresAt: Date.now() + expires * 1000,
  };
}

async function loopback(state, begin) {
  let resolveCallback;
  let rejectCallback;
  let consumed = false;
  const reply = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // The browser-opening promise can fail before the callback has been awaited.
  void reply.catch(() => {});
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK || consumed || url.searchParams.get('state') !== state) {
      res.writeHead(400).end('Invalid sign-in callback.');
      return;
    }
    consumed = true;
    const params = url.searchParams;
    const accepted = !params.has('error') && Boolean(params.get('code'));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(accepted ? 'Authorization received. Return to See Now to finish.' : 'Authorization was declined. Return to See Now.', () => {
      if (accepted) resolveCallback(params);
      else rejectCallback(new Error('ChatGPT authorization was declined.'));
    });
  });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK}`;
    timer = setTimeout(() => rejectCallback(new Error('Sign-in expired. Try again.')), 180000);
    await begin(redirectUri);
    return { params: await reply, redirectUri };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

export class Accounts {
  #path;
  #storage;
  #openBrowser;
  #state;
  #operation;
  #refresh;

  constructor({ directory, storage, openBrowser }) {
    this.#path = join(directory, 'accounts.enc');
    this.#storage = storage;
    this.#openBrowser = openBrowser;
  }

  async load() {
    try {
      const encrypted = await readFile(this.#path);
      this.#state = JSON.parse(this.#storage.decryptString(encrypted));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not open the protected See Now account file.');
      this.#state = { host: 'urn:uuid:' + randomUUID(), mode: 'local', profiles: [], selected: null };
    }
  }

  async #save(state = this.#state) {
    if (!this.#storage.isEncryptionAvailable() || this.#storage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('The operating system credential store is unavailable.');
    }
    const temp = this.#path + '.' + randomUUID();
    await writeFile(temp, this.#storage.encryptString(JSON.stringify(state)), { mode: 0o600, flag: 'wx' });
    await rename(temp, this.#path);
    this.#state = state;
  }

  status() {
    return {
      mode: this.#state.mode,
      selected: this.#state.selected,
      profiles: this.#state.profiles.map(({ clientId, email, token }) => ({
        id: clientId, email, connected: Boolean(token),
      })),
      hasApiKey: Boolean(this.#state.apiKey),
    };
  }

  async signIn(profileId) {
    if (this.#operation || this.#refresh) throw new Error('Wait for the current account operation to finish.');
    const profile = profileId ? this.#state.profiles.find(({ clientId }) => clientId === profileId) : undefined;
    if (profileId && !profile) throw new Error('Unknown ChatGPT account.');
    this.#operation = true;
    try {
      await this.#save();
      const state = nonceValue();
      const nonce = nonceValue();
      const verifier = nonceValue();
      const { params, redirectUri } = await loopback(state, async (uri) => {
        const url = new URL(ISSUER + '/api/accounts/authorize');
        url.search = new URLSearchParams({
          client_id: profile?.clientId ?? 'dynamic_agent_client',
          ...(profile ? {} : { agent_name_hint: 'see-now' }),
          ...(profile?.idToken ? { id_token_hint: profile.idToken } : {}),
          ext_agent_host_id: this.#state.host,
          response_type: 'code',
          redirect_uri: uri,
          scope: SCOPES,
          resource: API,
          state, nonce, code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        }).toString();
        await this.#openBrowser(url.href);
      });
      const clientId = params.get('client_id') || profile?.clientId;
      if (!clientId || clientId === 'dynamic_agent_client' || (profile && profile.clientId !== clientId)) {
        throw new Error('ChatGPT did not return the expected client registration.');
      }
      const token = await exchange({
        grant_type: 'authorization_code', client_id: clientId, code: params.get('code'),
        code_verifier: verifier, redirect_uri: redirectUri,
      });
      const identity = await verifiedIdentity(token.id_token, clientId, nonce);
      if (profile && profile.subject !== identity.sub) throw new Error('A different ChatGPT account signed in.');
      const updated = credentials(token, { clientId, subject: identity.sub, email: identity.email ?? 'ChatGPT' });
      await this.#save({
        ...this.#state, mode: 'plan', selected: clientId,
        profiles: [...this.#state.profiles.filter((entry) => entry.clientId !== clientId), updated],
      });
      return this.status();
    } finally {
      this.#operation = false;
    }
  }

  async choose(mode, value) {
    if (this.#operation || this.#refresh) throw new Error('Wait for the current account operation to finish.');
    if (!['local', 'plan', 'api'].includes(mode)) throw new Error('Unknown sign-in method.');
    const next = { ...this.#state, mode };
    if (mode === 'plan') {
      if (!next.profiles.some((entry) => entry.clientId === value && entry.token)) throw new Error('Reconnect this ChatGPT account.');
      next.selected = value;
    }
    if (mode === 'api' && typeof value === 'string' && value.trim()) {
      if (!/^sk-[\w-]+$/.test(value.trim())) throw new Error('Enter an OpenAI Platform API key.');
      next.apiKey = value.trim();
    }
    if (mode === 'api' && !next.apiKey) throw new Error('Enter an OpenAI Platform API key.');
    await this.#save(next);
    return this.status();
  }

  async getCredentials() {
    const { mode, apiKey, profiles, selected } = this.#state;
    if (mode === 'local') return { mode };
    if (mode === 'api') return { mode, token: apiKey };
    const profile = profiles.find(({ clientId }) => clientId === selected);
    if (!profile?.token) throw new Error('Sign in with ChatGPT to begin.');
    if (Date.now() < profile.expiresAt - 90000) return { mode, token: profile.token };
    if (!profile.refreshToken) throw new Error('Reconnect your ChatGPT account.');
    this.#refresh ??= this.#renew(profile).finally(() => { this.#refresh = undefined; });
    return { mode, token: await this.#refresh };
  }

  async #renew(profile) {
    const token = await exchange({
      grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: profile.refreshToken,
    });
    const updated = credentials(token, profile);
    await this.#save({
      ...this.#state,
      profiles: this.#state.profiles.map((entry) => entry.clientId === profile.clientId ? updated : entry),
    });
    return updated.token;
  }

  async models() {
    const { mode, token } = await this.getCredentials();
    if (mode !== 'plan') return [];
    const { models = [] } = await fetchJson(API + '/models', { headers: { Authorization: 'Bearer ' + token } });
    return models.filter(({ visibility, slug }) => visibility === 'list' && slug)
      .map(({ slug, display_name }) => ({ id: slug, name: display_name ?? slug }));
  }

  async signOut() {
    if (this.#operation || this.#refresh) throw new Error('Wait for the current account operation to finish.');
    this.#operation = true;
    try {
      const profile = this.#state.profiles.find(({ clientId }) => clientId === this.#state.selected);
      let warning;
      if (this.#state.mode === 'plan' && profile) {
        if (profile.refreshToken) {
          try {
            const result = await fetch(ISSUER + '/api/accounts/oauth/revoke', {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(7000),
              body: new URLSearchParams({ token: profile.refreshToken, token_type_hint: 'refresh_token', client_id: profile.clientId }),
            });
            if (!result.ok) throw new Error('Revocation failed.');
          } catch {
            warning = 'Signed out locally. Remote revocation could not be confirmed. You can disconnect See Now in ChatGPT Settings.';
          }
        }
        const { clientId, email, subject } = profile;
        await this.#save({
          ...this.#state, mode: 'local', selected: null,
          profiles: this.#state.profiles.map((entry) => entry.clientId === clientId ? { clientId, email, subject } : entry),
        });
      } else if (this.#state.mode === 'api') {
        await this.#save({ ...this.#state, mode: 'local', apiKey: undefined });
      }
      return { ...this.status(), warning };
    } finally {
      this.#operation = false;
    }
  }
}
