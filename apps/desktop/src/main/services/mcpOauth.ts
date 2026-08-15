import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { shell } from 'electron';
import { readSecret, writeSecret, deleteSecret, type EngineDeps } from '@contrail/engine';

/**
 * MCP OAuth 2.1 client — Contrail runs the flow ITSELF because the Agent
 * SDK cannot initiate client-side OAuth for a 401 remote server (verified
 * empirically: needs-auth is cached, no elicitation fires, and the Query
 * surface has no authenticate method). The chain is the MCP auth spec:
 *
 *   401 + WWW-Authenticate → protected-resource metadata (RFC 9728)
 *   → authorization-server metadata (RFC 8414)
 *   → dynamic client registration (RFC 7591, public client + PKCE)
 *   → authorization-code flow on a loopback redirect (same pattern as the
 *     Salesforce connect flow) → tokens in the KEYCHAIN, never on disk.
 *
 * The access token is then injected as an Authorization header wherever the
 * server's stored config is resolved (session start + connection test) —
 * riding the header path that already exists end to end.
 */

const KEYCHAIN_SERVICE = 'Contrail Desktop';
const AUTH_TIMEOUT_MS = 180_000;
/**
 * Fixed port for user-supplied OAuth clients: providers without dynamic
 * registration require the exact redirect URI in their app config, so it
 * must be stable and documented (OAUTH_LOOPBACK_REDIRECT in shared views).
 * DCR flows keep a random port — the registration names it per flow.
 */
const FIXED_LOOPBACK_PORT = 33418;

interface StoredToken {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms; absent = unknown lifetime (use until it 401s). */
  expires_at?: number;
  token_endpoint: string;
  client_id: string;
  /** Present for user-supplied confidential clients (client_secret_post). */
  client_secret?: string;
  /** RFC 8707 resource indicator (the MCP server URL). */
  resource: string;
  /** Scopes the provider actually GRANTED (Google's consent is granular). */
  scope?: string;
}

function account(serverId: string): string {
  return `mcp-oauth-${serverId}`;
}

/** Standalone token lookup — session start and the test probe inject this. */
export function mcpBearerFor(serverId: string): string | null {
  const raw = readSecret(KEYCHAIN_SERVICE, account(serverId));
  if (!raw) return null;
  try {
    const token = JSON.parse(raw) as StoredToken;
    return `Bearer ${token.access_token}`;
  } catch {
    return null;
  }
}

/** Scopes the provider granted at consent — null when unknown/no token. */
export function mcpGrantedScopes(serverId: string): string[] | null {
  const raw = readSecret(KEYCHAIN_SERVICE, account(serverId));
  if (!raw) return null;
  try {
    const token = JSON.parse(raw) as StoredToken;
    return token.scope ? token.scope.split(/\s+/).filter(Boolean) : null;
  } catch {
    return null;
  }
}

export function clearMcpToken(serverId: string): void {
  try {
    deleteSecret(KEYCHAIN_SERVICE, account(serverId));
  } catch {
    /* nothing stored */
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** RFC 9728 discovery: WWW-Authenticate resource_metadata, then well-known fallbacks. */
async function discoverResourceMetadata(
  serverUrl: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const challenge = res.headers.get('www-authenticate') ?? '';
    const match = /resource_metadata="([^"]+)"/i.exec(challenge);
    if (match) {
      const meta = await fetchJson(match[1]);
      if (meta) return meta;
    }
  } catch {
    /* fall through to well-known */
  }
  const u = new URL(serverUrl);
  for (const candidate of [
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ]) {
    const meta = await fetchJson(candidate);
    if (meta) return meta;
  }
  return null;
}

/** RFC 8414 (with OIDC fallback) for the authorization server's endpoints. */
async function discoverAuthServer(issuer: string): Promise<Record<string, unknown> | null> {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname;
  for (const candidate of [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}${path}/.well-known/oauth-authorization-server`,
    `${u.origin}/.well-known/openid-configuration`,
  ]) {
    const meta = await fetchJson(candidate);
    if (meta?.authorization_endpoint && meta?.token_endpoint) return meta;
  }
  return null;
}

export interface AuthorizeOutcome {
  ok: boolean;
  detail: string;
}

export class McpOAuthService {
  /** In-flight loopback server, one flow at a time. */
  private activeFlow: http.Server | null = null;

  constructor(
    private readonly deps: EngineDeps,
    private readonly openUrl: (url: string) => void = (url) => void shell.openExternal(url),
  ) {}

  readToken(serverId: string): StoredToken | null {
    const raw = readSecret(KEYCHAIN_SERVICE, account(serverId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  }

  /**
   * Full authorization for one server. Tries a silent refresh first; only
   * on failure does the browser open. Resolves when the loopback callback
   * lands (or times out). Every failure names the step that failed.
   */
  async authorize(serverId: string, timeoutMs: number = AUTH_TIMEOUT_MS): Promise<AuthorizeOutcome> {
    const server = this.deps.db.getCustomMcpServer(serverId);
    if (!server) return { ok: false, detail: 'Server not found.' };
    if (server.transport === 'stdio') {
      return { ok: false, detail: 'Local stdio servers use env config, not OAuth.' };
    }

    // NO silent-refresh short-circuit here: a refresh reuses the ORIGINAL
    // scope grant, so an explicit Authorize click must always run a fresh
    // consent — that is how a user picks up newly configured scopes.
    // (tryRefresh remains for automatic renewal paths.)
    const resourceMeta = await discoverResourceMetadata(server.urlOrCommand);
    const issuers = (resourceMeta?.authorization_servers as string[] | undefined) ?? [];
    // Legacy MCP discovery (2025-03 spec, used by Atlassian): no protected-
    // resource metadata; the MCP origin IS the authorization server.
    const candidates = issuers.length ? issuers : [new URL(server.urlOrCommand).origin];
    let authMeta: Record<string, unknown> | null = null;
    for (const issuer of candidates) {
      authMeta = await discoverAuthServer(issuer);
      if (authMeta) break;
    }
    if (!authMeta) {
      return {
        ok: false,
        detail:
          'No OAuth metadata found (neither RFC 9728 resource metadata nor RFC 8414 at the server origin). If the server supports token auth, paste a header instead.',
      };
    }

    // Loopback FIRST — the redirect URI must be known before registration.
    // A user-supplied client uses the FIXED port (the exact URI lives in
    // the provider's app config); DCR flows take any free port.
    if (this.activeFlow) {
      this.activeFlow.close();
      this.activeFlow = null;
    }
    const userClientId = server.config.oauthClientId?.trim();
    const userClientSecret = server.config.oauthClientSecret?.trim() || undefined;
    let loopback: http.Server;
    let port: number;
    try {
      ({ server: loopback, port } = await this.startLoopback(
        userClientId ? FIXED_LOOPBACK_PORT : 0,
      ));
    } catch (err) {
      return {
        ok: false,
        detail: userClientId
          ? `Port ${FIXED_LOOPBACK_PORT} is in use — the fixed OAuth callback port is required for user-supplied clients. (${String(err).slice(0, 120)})`
          : `Could not open a loopback listener: ${String(err).slice(0, 200)}`,
      };
    }
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    let clientId: string;
    let clientSecret: string | undefined;
    if (userClientId) {
      // Bring-your-own client (Slack, Google — providers without DCR).
      clientId = userClientId;
      clientSecret = userClientSecret;
    } else {
      const registrationEndpoint = authMeta.registration_endpoint as string | undefined;
      if (!registrationEndpoint) {
        loopback.close();
        return {
          ok: false,
          detail:
            'This provider does not support automatic client registration. Add an OAuth client ID/secret from an app you create with the provider (OAuth client… on the server card), or paste a token header.',
        };
      }
      const registered = await fetchJson(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Contrail Desktop',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      if (!registered?.client_id) {
        loopback.close();
        return {
          ok: false,
          detail:
            'Automatic client registration was refused — add an OAuth client ID/secret from an app you create with the provider instead.',
        };
      }
      clientId = registered.client_id as string;
    }

    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(24));
    const resource = (resourceMeta?.resource as string | undefined) ?? server.urlOrCommand;
    const scopes = (
      (resourceMeta?.scopes_supported as string[] | undefined) ??
      (authMeta.scopes_supported as string[] | undefined)
    )?.join(' ');

    const authUrl = new URL(authMeta.authorization_endpoint as string);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('resource', resource);
    if (scopes) authUrl.searchParams.set('scope', scopes);
    // Google only issues refresh tokens with offline access + explicit
    // consent; other providers ignore the unknown parameters.
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    const code = this.waitForCallback(loopback, state, timeoutMs);
    // waitForCallback wires handlers before we open the browser — no race.
    this.openUrl(authUrl.toString());
    const received = await code;
    this.activeFlow = null;
    if (!received.ok) return { ok: false, detail: received.detail };

    const tokenRes = await fetchJson(authMeta.token_endpoint as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: received.code,
        redirect_uri: redirectUri,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        code_verifier: verifier,
        resource,
      }).toString(),
    });
    if (!tokenRes?.access_token) {
      return { ok: false, detail: 'The token exchange failed after login.' };
    }
    const grantedScope =
      typeof tokenRes.scope === 'string' && tokenRes.scope.trim() ? tokenRes.scope.trim() : undefined;
    const stored: StoredToken = {
      access_token: tokenRes.access_token as string,
      refresh_token: tokenRes.refresh_token as string | undefined,
      expires_at:
        typeof tokenRes.expires_in === 'number'
          ? Date.now() + tokenRes.expires_in * 1000
          : undefined,
      token_endpoint: authMeta.token_endpoint as string,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      resource,
      ...(grantedScope ? { scope: grantedScope } : {}),
    };
    writeSecret(KEYCHAIN_SERVICE, account(serverId), JSON.stringify(stored));
    this.deps.audit.record('mcp.oauth_authorized', {
      tool: 'desktop_mcp_panel',
      outcome: 'success',
      detail: { serverId, name: server.name, scope: grantedScope ?? null },
    });
    // Granular consent (Google) can grant FEWER scopes than requested —
    // say what actually landed, because "authorized" with zero data scopes
    // still 403s on every real call.
    const requested = scopes ? scopes.split(/\s+/).length : 0;
    const granted = grantedScope ? grantedScope.split(/\s+/).length : null;
    const scopeNote = grantedScope
      ? ` Granted scopes (${granted}${requested ? ` of ${requested} requested` : ''}): ${grantedScope}`
      : '';
    return { ok: true, detail: `Authorized "${server.name}".${scopeNote}` };
  }

  private async tryRefresh(serverId: string, token: StoredToken): Promise<boolean> {
    if (!token.refresh_token) return false;
    const res = await fetchJson(token.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
        client_id: token.client_id,
        ...(token.client_secret ? { client_secret: token.client_secret } : {}),
        resource: token.resource,
      }).toString(),
    });
    if (!res?.access_token) return false;
    writeSecret(
      KEYCHAIN_SERVICE,
      account(serverId),
      JSON.stringify({
        ...token,
        access_token: res.access_token as string,
        refresh_token: (res.refresh_token as string | undefined) ?? token.refresh_token,
        expires_at:
          typeof res.expires_in === 'number' ? Date.now() + res.expires_in * 1000 : undefined,
        scope: (typeof res.scope === 'string' && res.scope.trim()) || token.scope,
      } satisfies StoredToken),
    );
    return true;
  }

  private startLoopback(fixedPort: number): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      server.on('error', reject);
      server.listen(fixedPort, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          this.activeFlow = server;
          resolve({ server, port: address.port });
        } else {
          reject(new Error('loopback listen failed'));
        }
      });
    });
  }

  private waitForCallback(
    server: http.Server,
    expectedState: string,
    timeoutMs: number,
  ): Promise<{ ok: true; code: string } | { ok: false; detail: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.close();
        resolve({ ok: false, detail: 'Timed out waiting for the browser login.' });
      }, timeoutMs);
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const deliver = (body: string): void => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
            `<!doctype html><meta charset="utf-8"><title>Contrail</title><body style="font-family:system-ui;padding:3rem"><h2>${body}</h2><p>You can close this tab and return to Contrail.</p></body>`,
          );
        };
        const err = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        clearTimeout(timer);
        server.close();
        if (err) {
          deliver('Authorization was declined.');
          resolve({ ok: false, detail: `The provider reported: ${err}` });
        } else if (!code || state !== expectedState) {
          deliver('Authorization failed.');
          resolve({ ok: false, detail: 'Callback missing code or state mismatch.' });
        } else {
          deliver('Authorized ✓');
          resolve({ ok: true, code });
        }
      });
    });
  }
}
