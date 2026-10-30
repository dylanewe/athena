import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { CHATGPT_ERRORS, type ChatGPTFailure, type ChatGPTModel } from '../shared/chatgpt';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
export const AUTH_TIMEOUT = 15_000;
export const LOGIN_TIMEOUT = 180_000;
export interface Tokens { idToken: string; accessToken?: string; refreshToken?: string; scopes: string[]; expiresAt: number }
export interface Registration { clientId: string; issuer: typeof ISSUER; subject: string; email?: string; reconnectRequired?: true; tokens?: Tokens }
export class ChatGPTError extends Error {
  constructor(public readonly reason: ChatGPTFailure) { super(CHATGPT_ERRORS[reason]); }
}
export const validClient = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512 && s !== 'dynamic_agent_client' && !/[\s\x00-\x1f\x7f]/u.test(s);
export const nonempty = (s: unknown): s is string => typeof s === 'string' && !!s.trim();
export const bearer = (s: unknown): s is string => nonempty(s) && s.length <= 64_000 && !/[\s\x00-\x1f\x7f]/u.test(s) && !s.startsWith('sk-');
export const planEnabled = (r?: Registration): boolean => !!r?.tokens?.accessToken && !!r.tokens.refreshToken && SCOPES.every(s => r.tokens!.scopes.includes(s)) && !r.reconnectRequired;

/** Bounded bodies, fixed endpoints, no redirects. Never return raw errors to the UI. */
export async function readJSON(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new ChatGPTError('protocol');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new ChatGPTError('protocol');
      parts.push(value);
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new ChatGPTError('protocol'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ChatGPTError('protocol');
    return data as Record<string, unknown>;
  } finally { void reader.cancel().catch(() => {}); }
}
export function responseFailure(status: number, body: Record<string, unknown>): ChatGPTFailure {
  const error = body.error;
  const code = typeof error === 'string' ? error : error && typeof error === 'object' ? (error as Record<string, unknown>).code : undefined;
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) return 'quota';
  if (code === 'subscription_sharing_user_not_eligible') return 'ineligible';
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') return 'unavailable';
  if (code === 'subscription_sharing_invalid_user') return 'authentication';
  if (code === 'chatpass_v2_scope_not_authorized' || code === 'chatpass_v2_invalid_authorization_context') return 'permission';
  if (code === 'model_not_found') return 'model';
  if (code === 'context_length_exceeded' || code === 'context_window_exceeded') return 'context';
  if (status === 401) return 'authentication';
  if (status === 403) return 'ineligible';
  return status >= 500 ? 'unavailable' : 'protocol';
}

export interface OAuthProtocol {
  login(hostId: string, saved: Registration | undefined, consent: boolean, signal: AbortSignal): Promise<Registration>;
  refresh(saved: Registration): Promise<Registration>;
  catalog(token: string, signal: AbortSignal): Promise<ChatGPTModel[]>;
  revoke(saved: Registration, signal: AbortSignal): Promise<boolean>;
}

export class ChatGPTOAuth implements OAuthProtocol {
  private readonly keys: JWTVerifyGetKey;
  constructor(private readonly openBrowser: (url: string) => Promise<void>, private readonly http: typeof fetch = (...args) => globalThis.fetch(...args), keys?: JWTVerifyGetKey) {
    this.keys = keys ?? createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), {
      timeoutDuration: AUTH_TIMEOUT,
      [customFetch]: (url, options) => this.http(url, { ...options, redirect: 'error' }),
    });
  }
  private async verify(token: unknown, clientId: string, subject?: string, nonce?: string): Promise<JWTPayload> {
    if (!nonempty(token) || token.length > 64_000) throw new ChatGPTError('authentication');
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256'], clockTolerance: 5, requiredClaims: ['sub', 'exp', 'iat'],
      });
      if (!nonempty(payload.sub) || (subject !== undefined && payload.sub !== subject) ||
        (nonce !== undefined && payload.nonce !== nonce) || (payload.azp !== undefined && payload.azp !== clientId) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error();
      return payload;
    } catch { throw new ChatGPTError('authentication'); }
  }
  private async tokenSet(body: Record<string, unknown>, clientId: string, saved?: Registration, nonce?: string): Promise<Registration> {
    const previous = saved?.tokens;
    const idToken = body.id_token === undefined && nonce === undefined ? previous?.idToken : body.id_token;
    // A refresh need not issue a new ID token: the old verified identity remains pinned even after ID-token expiry.
    const claims = body.id_token !== undefined || nonce !== undefined ? await this.verify(idToken, clientId, saved?.subject, nonce) : undefined;
    if (!nonempty(idToken) || (!claims && !saved)) throw new ChatGPTError('authentication');
    const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/u).filter(Boolean) : body.scope === undefined && nonce === undefined ? previous?.scopes : undefined;
    if (!scopes || scopes.length > 100 || scopes.some(s => s.length > 256)) throw new ChatGPTError('protocol');
    const permitted = SCOPES.every(s => scopes.includes(s));
    const accessToken = body.access_token;
    const refreshToken = body.refresh_token === undefined && nonce === undefined ? previous?.refreshToken : body.refresh_token;
    if (accessToken !== undefined && !bearer(accessToken)) throw new ChatGPTError('protocol');
    if (refreshToken !== undefined && (!nonempty(refreshToken) || refreshToken.length > 64_000 || /[\s\x00-\x1f\x7f]/u.test(refreshToken))) throw new ChatGPTError('protocol');
    if (accessToken !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')) throw new ChatGPTError('protocol');
    const expires = body.expires_in;
    const validExpiry = typeof expires === 'number' && Number.isFinite(expires) && expires > 0 && Number.isSafeInteger(Math.ceil(Date.now() + expires * 1000));
    if (permitted && (!bearer(accessToken) || !nonempty(refreshToken) || !validExpiry)) throw new ChatGPTError('protocol');
    const email = claims?.email;
    return {
      clientId, issuer: ISSUER, subject: claims?.sub ?? saved!.subject,
      ...(typeof email === 'string' && email.length <= 320 ? { email } : saved?.email ? { email: saved.email } : {}),
      tokens: { idToken, ...(accessToken ? { accessToken: accessToken as string } : {}), ...(refreshToken ? { refreshToken: refreshToken as string } : {}), scopes, expiresAt: validExpiry ? Date.now() + (expires as number) * 1000 : 0 },
    };
  }
  private async exchange(fields: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.http(`${ISSUER}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...fields, resource: RESOURCE }), redirect: 'error', signal,
    });
    const body = await readJSON(response);
    if (!response.ok) {
      if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(String(body.error))) throw new ChatGPTError('authentication');
      throw new ChatGPTError(responseFailure(response.status, body));
    }
    return body;
  }
  async login(hostId: string, saved: Registration | undefined, consent: boolean, outerSignal: AbortSignal): Promise<Registration> {
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(LOGIN_TIMEOUT)]);
    signal.throwIfAborted();
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    let redirect = '';
    let consumed = false;
    let resolve!: (value: { code: string; clientId: string }) => void;
    let reject!: (error: Error) => void;
    const callback = new Promise<{ code: string; clientId: string }>((yes, no) => { resolve = yes; reject = no; });
    // Attach before browser launch/listening so cancellation cannot create an unhandled rejection.
    void callback.catch(() => {});
    const server = createServer((request, response) => {
      const reply = (status: number) => {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer', Connection: 'close' });
        response.end(status === 200 ? 'Return to Athena to check the connection.' : 'Callback rejected. Return to Athena.');
      };
      let url: URL;
      try { url = new URL(request.url ?? '', redirect); } catch { reply(400); return; }
      const expected = new URL(redirect);
      if (request.method !== 'GET' || request.headers.host !== expected.host || url.origin !== expected.origin || url.pathname !== '/auth/callback' || url.hash) { reply(400); return; }
      const params = url.searchParams;
      if (['state', 'code', 'client_id', 'error'].some(key => params.getAll(key).length > 1) || params.get('state') !== state || consumed) { reply(400); return; }
      consumed = true;
      reply(200);
      server.close();
      const clientId = params.get('client_id') ?? saved?.clientId;
      if (params.has('error')) { reject(new ChatGPTError('permission')); return; }
      if (!validClient(clientId) || (saved && clientId !== saved.clientId) || !nonempty(params.get('code')) || params.get('code')!.length > 16_384) { reject(new ChatGPTError('authentication')); return; }
      resolve({ code: params.get('code')!, clientId });
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.maxConnections = 16;
    const abort = () => { reject(new ChatGPTError('cancelled')); server.close(); server.closeAllConnections(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
      signal.throwIfAborted();
      const address = server.address();
      if (!address || typeof address === 'string') throw new ChatGPTError('protocol');
      redirect = `http://127.0.0.1:${address.port}/auth/callback`;
      const url = new URL(`${ISSUER}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: saved?.clientId ?? 'dynamic_agent_client', ...(saved ? {} : { agent_name_hint: 'Athena' }),
        ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirect, scope: SCOPES.join(' '), resource: RESOURCE,
        state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        ...(saved?.tokens?.idToken ? { id_token_hint: saved.tokens.idToken } : {}), ...(saved?.email ? { login_hint: saved.email } : {}),
        ...(consent ? { prompt: 'consent' } : {}),
      }).toString();
      // Browser launch is not allowed to keep the attempt alive past cancellation/timeout.
      void this.openBrowser(url.href).catch(() => reject(new ChatGPTError('unavailable')));
      const result = await callback;
      signal.throwIfAborted();
      const body = await this.exchange({ grant_type: 'authorization_code', client_id: result.clientId, code: result.code, code_verifier: verifier, redirect_uri: redirect }, AbortSignal.any([signal, AbortSignal.timeout(AUTH_TIMEOUT)]));
      const registration = await this.tokenSet(body, result.clientId, saved, nonce);
      signal.throwIfAborted();
      return registration;
    } finally { signal.removeEventListener('abort', abort); server.close(); server.closeAllConnections(); }
  }
  async refresh(saved: Registration): Promise<Registration> {
    if (!saved.tokens?.refreshToken) throw new ChatGPTError('authentication');
    // Deliberately independent of foreground cancellation: persist a rotated token before discarding request authority.
    const body = await this.exchange({ grant_type: 'refresh_token', client_id: saved.clientId, refresh_token: saved.tokens.refreshToken }, AbortSignal.timeout(AUTH_TIMEOUT));
    return this.tokenSet(body, saved.clientId, saved);
  }
  async catalog(token: string, signal: AbortSignal): Promise<ChatGPTModel[]> {
    const response = await this.http(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(AUTH_TIMEOUT)]) });
    const body = await readJSON(response);
    if (!response.ok) throw new ChatGPTError(responseFailure(response.status, body));
    if (!Array.isArray(body.models) || body.models.length > 2000) throw new ChatGPTError('protocol');
    const models: ChatGPTModel[] = [];
    const ids = new Set<string>();
    for (const value of body.models) {
      if (!value || typeof value !== 'object') throw new ChatGPTError('protocol');
      if (value.visibility !== 'list') continue;
      if (!nonempty(value.slug) || value.slug.length > 256 || /[\s\x00-\x1f\x7f]/u.test(value.slug) || !nonempty(value.display_name) || value.display_name.length > 256 || ids.has(value.slug)) throw new ChatGPTError('protocol');
      ids.add(value.slug); models.push({ id: value.slug, name: value.display_name });
    }
    return models;
  }
  async revoke(saved: Registration, signal: AbortSignal): Promise<boolean> {
    if (!saved.tokens?.refreshToken) return true;
    try {
      const discoveryResponse = await this.http(`${ISSUER}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
      if (!discoveryResponse.ok) return false;
      const discovery = await readJSON(discoveryResponse);
      if (discovery.issuer !== ISSUER || typeof discovery.revocation_endpoint !== 'string') return false;
      const endpoint = new URL(discovery.revocation_endpoint);
      if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        try {
          const response = await this.http(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: saved.tokens.refreshToken, token_type_hint: 'refresh_token', client_id: saved.clientId }) });
          void response.body?.cancel().catch(() => {});
          if (response.status === 200) return true;
          if (response.status < 500 && response.status !== 429) return false;
        } catch { if (signal.aborted) return false; }
        if (!attempt) await new Promise(done => setTimeout(done, 200));
      }
    } catch { /* No raw URLs, token bodies, or errors cross the boundary. */ }
    return false;
  }
}
