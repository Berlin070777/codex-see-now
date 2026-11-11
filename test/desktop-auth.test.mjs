import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../desktop/core/auth.mjs';

test('ChatGPT sign-in verifies the loopback callback, PKCE, signed identity and plan scope', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'see-now-auth-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test' };
  const realFetch = globalThis.fetch;
  const encode = (object) => Buffer.from(JSON.stringify(object)).toString('base64url');
  let browserUrl;

  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, options);
    if (String(url).endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    assert.equal(String(url), 'https://auth.openai.com/api/accounts/oauth/token');
    const body = options.body;
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('client_id'), 'oaiapp_test');
    assert.equal(body.get('redirect_uri'), browserUrl.searchParams.get('redirect_uri'));
    const challenge = createHash('sha256').update(body.get('code_verifier')).digest('base64url');
    assert.equal(challenge, browserUrl.searchParams.get('code_challenge'));
    const unsigned = encode({ alg: 'RS256', kid: 'test' }) + '.' + encode({
      iss: 'https://auth.openai.com', sub: 'verified', email: 'observer@example.test',
      aud: 'oaiapp_test', exp: Date.now() / 1000 + 600,
      nonce: browserUrl.searchParams.get('nonce'),
    });
    return Response.json({
      access_token: 'access-token', expires_in: 3600,
      scope: 'openid chatgpt.tokens.use.direct',
      id_token: unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url'),
    });
  });

  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(Buffer.from(value).toString('base64')),
    decryptString: (value) => Buffer.from(value.toString(), 'base64').toString(),
  };
  const accounts = new Accounts({
    directory, storage,
    async openBrowser(value) {
      browserUrl = new URL(value);
      assert.equal(browserUrl.origin, 'https://auth.openai.com');
      assert.equal(browserUrl.searchParams.get('client_id'), 'dynamic_agent_client');
      const callback = new URL(browserUrl.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', 'incorrect');
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', browserUrl.searchParams.get('state'));
      callback.searchParams.set('client_id', 'oaiapp_test');
      callback.searchParams.set('code', 'authorization-code');
      const response = await fetch(callback);
      assert.equal(response.status, 200);
      await response.text();
    },
  });

  await accounts.load();
  const result = await accounts.signIn();
  assert.equal(result.mode, 'plan');
  assert.equal(result.profiles[0].email, 'observer@example.test');
  assert.equal(JSON.stringify(result).includes('access-token'), false);
  assert.deepEqual(await accounts.getCredentials(), { mode: 'plan', token: 'access-token' });
  const stored = await readFile(join(directory, 'accounts.enc'));
  assert.equal(stored.toString().includes('access-token'), false);
});
