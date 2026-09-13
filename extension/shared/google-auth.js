// Signing in to Google for Drive and Docs access.
//
// Uses chrome.identity.launchWebAuthFlow with a "Web application" OAuth
// client, rather than chrome.identity.getAuthToken with a client id baked
// into manifest.json. The practical difference: the client id is pasted
// into Settings instead of edited into the extension's files, and the
// Settings page can show the exact redirect URI Google Cloud needs —
// nothing to work out, nothing to rebuild.
//
// Scopes are the narrowest that do the job, and neither is "sensitive"
// or "restricted" in Google's terms, so no verification review is needed:
//   drive.file     only files Edge Studio itself created — its folders and
//                  Docs — never the rest of your Drive
//   drive.appdata  a hidden app-data folder for the index that lets any
//                  machine rebuild blocks, scenes and tags from Drive
//
// Access tokens last about an hour. They're kept in storage.session
// (cleared when the browser closes, never written to disk) and renewed
// silently while your Google session is signed in; if Google needs you
// to click through again, sync pauses with "Reconnect" in Settings.

import { getSetting, updateSetting } from './store.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.appdata',
];

const TOKEN_KEY = 'googleToken';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
// Renew a little before the token actually expires, so a sync that
// starts just before expiry doesn't fail halfway through.
const EXPIRY_MARGIN_MS = 90 * 1000;

export class NeedsReconnectError extends Error {
  constructor(message = 'Google needs you to reconnect.') {
    super(message);
    this.name = 'NeedsReconnectError';
  }
}

export function redirectUri() {
  return chrome.identity.getRedirectURL();
}

export function looksLikeClientId(value) {
  return /^[\w-]+\.apps\.googleusercontent\.com$/.test(String(value || '').trim());
}

async function readToken() {
  const data = await chrome.storage.session.get(TOKEN_KEY);
  return data[TOKEN_KEY] || null;
}

async function writeToken(token) {
  if (token) await chrome.storage.session.set({ [TOKEN_KEY]: token });
  else await chrome.storage.session.remove(TOKEN_KEY);
}

function buildAuthUrl({ clientId, interactive, loginHint }) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('include_granted_scopes', 'true');
  if (!interactive) url.searchParams.set('prompt', 'none');
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.href;
}

// Reads the token (or the error) out of the redirect Google sends back.
export function parseAuthResponse(responseUrl) {
  const hash = new URL(responseUrl).hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  if (params.get('error')) {
    return { error: params.get('error'), description: params.get('error_description') || '' };
  }
  const accessToken = params.get('access_token');
  if (!accessToken) return { error: 'no_token', description: 'Google did not return an access token.' };
  const granted = (params.get('scope') || '').split(/\s+/).filter(Boolean);
  return {
    accessToken,
    expiresIn: Number(params.get('expires_in')) || 3600,
    granted,
  };
}

async function runFlow({ interactive }) {
  const google = (await getSetting('google', {})) || {};
  if (!looksLikeClientId(google.clientId)) {
    throw new Error('Add your Google OAuth client ID in Settings first.');
  }

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: buildAuthUrl({ clientId: google.clientId.trim(), interactive, loginHint: google.account?.email }),
      interactive,
    });
  } catch (error) {
    // Non-interactive attempts fail this way whenever Google wants a
    // click — that's the signal to ask for a reconnect, not a bug.
    if (!interactive) throw new NeedsReconnectError();
    throw new Error(`Google sign-in didn't complete: ${error.message}`);
  }

  const result = parseAuthResponse(responseUrl);
  if (result.error) {
    if (!interactive) throw new NeedsReconnectError();
    throw new Error(
      result.error === 'access_denied'
        ? 'Google access was declined.'
        : `Google sign-in failed: ${result.description || result.error}`
    );
  }

  // Google's consent screen lets people untick individual permissions.
  // Without both, sync can't work, so say which one is missing.
  const missing = SCOPES.filter((scope) => !result.granted.includes(scope));
  if (result.granted.length && missing.length) {
    throw new Error(
      `Edge Studio needs both Drive permissions. Missing: ${missing
        .map((s) => s.split('/').pop())
        .join(', ')}. Connect again and leave both ticked.`
    );
  }

  const token = {
    accessToken: result.accessToken,
    expiresAt: Date.now() + result.expiresIn * 1000,
  };
  await writeToken(token);
  return token.accessToken;
}

// A valid access token, renewing silently if needed. Throws
// NeedsReconnectError if Google needs the user to click through again.
export async function getAccessToken() {
  const token = await readToken();
  if (token && token.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return token.accessToken;
  return runFlow({ interactive: false });
}

// Forgets the cached token so the next request renews it. Called when
// Google rejects a token that looked unexpired.
export async function invalidateToken() {
  await writeToken(null);
}

// The Connect button. Must run from a user gesture on an extension page.
export async function connect({ fetchAccount }) {
  const accessToken = await runFlow({ interactive: true });
  const account = await fetchAccount(accessToken);
  await updateSetting('google', {
    connected: true,
    account,
    status: 'idle',
    lastError: null,
    connectedAt: new Date().toISOString(),
  });
  return account;
}

// Disconnecting stops syncing and revokes this browser's access. It does
// not touch anything in Drive: the Docs and folders stay yours.
export async function disconnect() {
  const token = await readToken();
  await writeToken(null);
  if (token?.accessToken) {
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token.accessToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch {
      // Offline or already revoked — the local token is gone either way.
    }
  }
  await updateSetting('google', { connected: false, status: 'off', lastError: null });
}
