// ── GitHub OAuth Device Flow (main process) ─────────────────────────────
//
// Implements https://docs.github.com/apps/oauth-apps/building-oauth-apps/
// authorizing-oauth-apps#device-flow so the editor can push/pull HTTPS
// remotes like VS Code does: the user enters a short code on github.com
// once, we poll for the access token and inject it into git via an
// in-memory credential helper (see git.ts).
//
// Device flow needs only a public client_id (no secret). The user registers
// their own OAuth App (Settings → Developer settings → OAuth Apps, with
// "Enable Device Flow" checked) and pastes the client id in the UI once.

import * as https from 'https';

export interface DeviceCodeInfo {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  /** Minimum seconds between token polls. */
  interval: number;
}

function postJson(
  host: string,
  path: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<any> {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'forge-code',
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Respuesta inesperada de GitHub (HTTP ${res.statusCode}).`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export async function startDeviceFlow(clientId: string): Promise<DeviceCodeInfo> {
  const res = await postJson('github.com', '/login/device/code', {
    client_id: clientId,
    scope: 'repo',
  });
  if (!res.device_code) {
    // GitHub answers `{"error":"Not Found"}` for an unknown client id and
    // `device_flow_disabled` when the OAuth App doesn't have it enabled.
    if (res.error === 'Not Found') {
      throw new Error('GitHub no reconoce ese Client ID. Revisa que lo copiaste bien.');
    }
    if (res.error === 'device_flow_disabled') {
      throw new Error(
        'La OAuth App no tiene Device Flow habilitado. Actívalo en la configuración de la app en GitHub.',
      );
    }
    throw new Error(
      res.error_description ||
        res.error ||
        'GitHub rechazó la solicitud. ¿El Client ID es correcto y la OAuth App tiene Device Flow habilitado?',
    );
  }
  return {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUri: res.verification_uri || 'https://github.com/login/device',
    expiresIn: Number(res.expires_in) || 900,
    interval: Number(res.interval) || 5,
  };
}

// Only one device-flow poll loop at a time; starting a new flow (or logging
// out) cancels the previous one.
let activeFlowId = 0;
export function cancelDeviceFlow(): void {
  activeFlowId++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll GitHub until the user authorizes the device (or the code expires).
 *  Resolves with the access token. */
export async function waitForDeviceToken(
  clientId: string,
  info: DeviceCodeInfo,
): Promise<string> {
  const flowId = ++activeFlowId;
  const deadline = Date.now() + info.expiresIn * 1000;
  let intervalMs = Math.max(5, info.interval) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    if (flowId !== activeFlowId) throw new Error('Autenticación cancelada.');

    const res = await postJson('github.com', '/login/oauth/access_token', {
      client_id: clientId,
      device_code: info.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    if (res.access_token) return String(res.access_token);
    switch (res.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += 5000;
        continue;
      case 'expired_token':
        throw new Error('El código expiró. Vuelve a iniciar sesión.');
      case 'access_denied':
        throw new Error('Autorización denegada en GitHub.');
      default:
        throw new Error(res.error_description || res.error || 'Error desconocido de GitHub.');
    }
  }
  throw new Error('El código expiró. Vuelve a iniciar sesión.');
}

/** Fetch the authenticated user's login (also validates the token). */
export function fetchGithubLogin(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'api.github.com',
        path: '/user',
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'forge-code',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode === 200 && parsed.login) resolve(String(parsed.login));
            else reject(new Error(parsed.message || `GitHub respondió HTTP ${res.statusCode}.`));
          } catch {
            reject(new Error('Respuesta inesperada de GitHub.'));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
