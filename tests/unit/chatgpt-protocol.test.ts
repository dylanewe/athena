import { beforeAll, expect, test } from 'vitest';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { ChatGPTOAuth, ISSUER, RESOURCE, SCOPES, type Registration } from '../../src/main/chatgpt-protocol';

let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  pair = await generateKeyPair('RS256');
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test' }] });
});
async function signed(claims: JWTPayload = {}) {
  return new SignJWT({ sub: 'subject', nonce: 'nonce', email: 'person@example.test', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(String(claims.iss ?? ISSUER)).setAudience(claims.aud ?? 'issued-client')
    .setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);
}
function callback(url: URL, options: { method?: string; host?: string; path?: string } = {}): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'GET', headers: options.host ? { Host: options.host } : {}, ...(options.path ? { path: options.path } : {}) }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}
const saved = (tokens?: Registration['tokens']): Registration => ({ clientId: 'issued-client', issuer: ISSUER, subject: 'subject', tokens });
async function attempt(options: { claims?: JWTPayload; saved?: Registration; body?: Record<string, unknown>; consent?: boolean } = {}) {
  let authorization!: URL;
  let fields!: URLSearchParams;
  let page!: Awaited<ReturnType<typeof callback>>;
  const http: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(`${ISSUER}/api/accounts/oauth/token`);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    fields = init!.body as URLSearchParams;
    return Response.json({ id_token: await signed({ nonce: authorization.searchParams.get('nonce'), ...options.claims }), access_token: 'oauth-access', refresh_token: 'oauth-refresh', token_type: 'Bearer', expires_in: 3600, scope: SCOPES.join(' '), ...options.body });
  };
  const oauth = new ChatGPTOAuth(async url => {
    authorization = new URL(url);
    const dest = new URL(authorization.searchParams.get('redirect_uri')!);
    dest.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'authorization-code', client_id: 'issued-client' }).toString();
    page = await callback(dest);
  }, http, jwks);
  const result = await oauth.login('urn:uuid:host', options.saved, options.consent ?? false, new AbortController().signal);
  await expect.poll(() => !!page).toBe(true);
  return { result, authorization, fields, page };
}

test('dynamic registration uses exact PKCE, callback, scopes and verified identity; callback page leaks no secrets', async () => {
  const { result, authorization, fields, page } = await attempt();
  expect(authorization.origin + authorization.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
  expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect(authorization.searchParams.get('agent_name_hint')).toBe('Athena');
  expect(authorization.searchParams.get('scope')).toBe(SCOPES.join(' '));
  expect(authorization.searchParams.get('resource')).toBe(RESOURCE);
  expect(authorization.searchParams.get('state')).not.toBe(authorization.searchParams.get('nonce'));
  expect(authorization.searchParams.get('state')).toHaveLength(43);
  expect(fields.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'));
  expect(fields.get('client_id')).toBe('issued-client');
  expect(fields.has('client_secret')).toBe(false);
  expect(createHash('sha256').update(fields.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
  expect(result).toMatchObject({ clientId: 'issued-client', subject: 'subject', email: 'person@example.test', tokens: { accessToken: 'oauth-access', refreshToken: 'oauth-refresh', scopes: SCOPES } });
  expect(page.headers).toMatchObject({ 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'", 'referrer-policy': 'no-referrer' });
  expect(page.body).not.toContain('authorization-code');
  await expect(callback(new URL(fields.get('redirect_uri')!))).rejects.toThrow();
});

test('reconnect pins registration, omits initial name, and requests consent only explicitly', async () => {
  const registration = saved({ idToken: 'old-id', accessToken: 'oauth-access', refreshToken: 'oauth-refresh', expiresAt: 0, scopes: SCOPES });
  const { authorization } = await attempt({ saved: registration, consent: true });
  expect(authorization.searchParams.get('client_id')).toBe('issued-client');
  expect(authorization.searchParams.has('agent_name_hint')).toBe(false);
  expect(authorization.searchParams.get('id_token_hint')).toBe('old-id');
  expect(authorization.searchParams.get('prompt')).toBe('consent');
});

test.each([
  { claims: { nonce: 'wrong' } }, { claims: { iss: 'https://attacker.test' } }, { claims: { aud: 'another-client' } },
  { claims: { azp: 'another-client' } }, { claims: { aud: ['issued-client', 'other'] } },
  { saved: saved(), claims: { sub: 'other-subject' } },
  { body: { access_token: 'sk-api-key' } }, { body: { token_type: 'Basic' } }, { body: { expires_in: -1 } },
  { body: { refresh_token: undefined } }, { body: { scope: undefined } }, { body: { id_token: 'unverified.jwt.value' } },
])('rejects invalid identity or usable token set: %j', async options => { await expect(attempt(options)).rejects.toThrow(); });

test('identity-only sign-in is retained without being represented as plan permission', async () => {
  const { result } = await attempt({ body: { scope: 'openid profile email', access_token: undefined, refresh_token: undefined, expires_in: undefined } });
  expect(result.tokens).toMatchObject({ scopes: ['openid', 'profile', 'email'], expiresAt: 0 });
  expect(result.tokens?.accessToken).toBeUndefined();
});

test('bad host, method, origin, path, duplicate parameters and wrong state cannot consume an attempt', async () => {
  const controller = new AbortController();
  let opened!: URL;
  let exchanges = 0;
  const oauth = new ChatGPTOAuth(async url => { opened = new URL(url); }, async () => { exchanges++; throw new Error(); }, jwks);
  const promise = oauth.login('host', undefined, false, controller.signal);
  void promise.catch(() => {});
  await expect.poll(() => !!opened).toBe(true);
  const dest = new URL(opened.searchParams.get('redirect_uri')!);
  dest.search = new URLSearchParams({ state: opened.searchParams.get('state')!, code: 'code', client_id: 'issued-client' }).toString();
  for (const options of [{ method: 'POST' }, { host: 'evil.test' }, { path: '/elsewhere' }, { path: `http://evil.test/auth/callback${dest.search}` }]) expect((await callback(dest, options)).status).toBe(400);
  for (const key of ['state', 'code', 'client_id', 'error']) {
    const duplicate = new URL(dest); duplicate.searchParams.append(key, 'x'); duplicate.searchParams.append(key, 'y');
    expect((await callback(duplicate)).status).toBe(400);
  }
  const wrong = new URL(dest); wrong.searchParams.set('state', 'wrong');
  expect((await callback(wrong)).status).toBe(400);
  const denied = new URL(dest); denied.searchParams.set('error', 'access_denied');
  expect((await callback(denied)).status).toBe(200);
  await expect(promise).rejects.toThrow('permission');
  expect(exchanges).toBe(0);
  await expect(callback(dest)).rejects.toThrow();
});

test.each(['dynamic_agent_client', 'bad client', 'x'.repeat(513), 'different-client'])('rejects invalid or mismatched callback client %s', async id => {
  const oauth = new ChatGPTOAuth(async url => {
    const auth = new URL(url), dest = new URL(auth.searchParams.get('redirect_uri')!);
    dest.search = new URLSearchParams({ state: auth.searchParams.get('state')!, code: 'code', client_id: id }).toString();
    await callback(dest);
  }, async () => { throw new Error('Must not exchange'); }, jwks);
  await expect(oauth.login('host', saved(), false, new AbortController().signal)).rejects.toThrow('authorization');
});

test('cancellation closes listener and ignores a late browser completion', async () => {
  let opened!: URL;
  const controller = new AbortController();
  const oauth = new ChatGPTOAuth(async url => { opened = new URL(url); await new Promise(() => {}); }, undefined, jwks);
  const promise = oauth.login('host', undefined, false, controller.signal); void promise.catch(() => {});
  await expect.poll(() => !!opened).toBe(true);
  controller.abort();
  await expect(promise).rejects.toThrow('cancelled');
  await expect(callback(new URL(opened.searchParams.get('redirect_uri')!))).rejects.toThrow();
});

test('refresh preserves omitted refresh token/scopes/ID token without revalidating an expired retained ID token', async () => {
  const oauth = new ChatGPTOAuth(async () => {}, async (_url, options) => {
    expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({ grant_type: 'refresh_token', client_id: 'issued-client', refresh_token: 'refresh-old', resource: RESOURCE });
    return Response.json({ access_token: 'access-new', token_type: 'Bearer', expires_in: 3600 });
  }, jwks);
  const result = await oauth.refresh(saved({ idToken: 'previously-verified-expired-id', accessToken: 'access-old', refreshToken: 'refresh-old', scopes: SCOPES, expiresAt: 0 }));
  expect(result.tokens).toMatchObject({ idToken: 'previously-verified-expired-id', accessToken: 'access-new', refreshToken: 'refresh-old', scopes: SCOPES });
});

test('refresh verifies any new ID token against the saved subject', async () => {
  const oauth = new ChatGPTOAuth(async () => {}, async () => Response.json({ id_token: await signed({ sub: 'other' }), access_token: 'new', token_type: 'Bearer', expires_in: 3600 }), jwks);
  await expect(oauth.refresh(saved({ idToken: 'old', refreshToken: 'old-refresh', scopes: SCOPES, expiresAt: 0 }))).rejects.toThrow('authorization');
});

test('catalog uses the OAuth-specific shape and preserves display ordering', async () => {
  const oauth = new ChatGPTOAuth(async () => {}, async (url, options) => {
    expect(String(url)).toBe(`${RESOURCE}/models`); expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer access');
    return Response.json({ models: [{ slug: 'b', display_name: 'B', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'a', display_name: 'A', visibility: 'list' }] });
  }, jwks);
  expect(await oauth.catalog('access', new AbortController().signal)).toEqual([{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }]);
});

test.each([
  { data: [] }, { models: [null] }, { models: [{ slug: 'bad id', display_name: 'Bad', visibility: 'list' }] },
  { models: [{ slug: 'a', display_name: 'A', visibility: 'list' }, { slug: 'a', display_name: 'A', visibility: 'list' }] },
])('catalog rejects incompatible or malformed responses', async body => {
  const oauth = new ChatGPTOAuth(async () => {}, async () => Response.json(body), jwks);
  await expect(oauth.catalog('access', new AbortController().signal)).rejects.toThrow();
});

test.each(['https://evil.test/revoke', `${ISSUER}/revoke?token=x`, `${ISSUER}/revoke#x`, 'https://user:password@auth.openai.com/revoke'])('revocation rejects unsafe discovery endpoint %s', async endpoint => {
  let calls = 0;
  const oauth = new ChatGPTOAuth(async () => {}, async () => { calls++; return Response.json({ issuer: ISSUER, revocation_endpoint: endpoint }); }, jwks);
  expect(await oauth.revoke(saved({ idToken: 'id', refreshToken: 'refresh', scopes: SCOPES, expiresAt: 0 }), new AbortController().signal)).toBe(false);
  expect(calls).toBe(1);
});

test('revocation retries transient failure once, uses only the issued client and refresh token, accepts empty 200', async () => {
  let attempts = 0;
  const oauth = new ChatGPTOAuth(async () => {}, async (url, init) => {
    if (String(url).endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, revocation_endpoint: `${ISSUER}/revoke` });
    attempts++;
    expect(init?.redirect).toBe('error');
    expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({ token: 'refresh', token_type_hint: 'refresh_token', client_id: 'issued-client' });
    return new Response(null, { status: attempts === 1 ? 503 : 200 });
  }, jwks);
  expect(await oauth.revoke(saved({ idToken: 'id', refreshToken: 'refresh', scopes: SCOPES, expiresAt: 0 }), new AbortController().signal)).toBe(true);
  expect(attempts).toBe(2);
});
