import { createHash } from 'node:crypto';

export interface PhonePasskeyRequest {
  challenge: string;
  rpId: 'google.com' | 'accounts.google.com';
  timeout: number;
  userVerification: 'required' | 'preferred' | 'discouraged';
  allowCredentials: Array<{ type: 'public-key'; id: string; transports?: string[] }>;
}
export function passkeyOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.origin === 'https://accounts.google.com' && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}
function bytes(value: unknown, min: number, max: number): Buffer | null {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length >= min && decoded.length <= max && decoded.toString('base64url') === value ? decoded : null;
}

/** Admission is deliberately narrower than WebAuthn: Google, top-level, get,
 * existing phone credentials. Unsupported browser features use native WebAuthn. */
export function normalizePhonePasskeyRequest(input: unknown): PhonePasskeyRequest | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, any>;
  if (!['google.com', 'accounts.google.com'].includes(value.rpId) || !bytes(value.challenge, 16, 8192)
    || !Array.isArray(value.allowCredentials) || value.allowCredentials.length > 100
    || !['required', 'preferred', 'discouraged'].includes(value.userVerification)
    || (value.timeout !== undefined && (typeof value.timeout !== 'number' || !Number.isFinite(value.timeout) || value.timeout <= 0))) return null;
  let total = 0;
  const credentials: PhonePasskeyRequest['allowCredentials'] = [];
  for (const credential of value.allowCredentials) {
    const id = bytes(credential?.id, 1, 1024);
    if (credential?.type !== 'public-key' || !id || (total += id.length) > 65_536
      || (credential.transports !== undefined && (!Array.isArray(credential.transports)
        || credential.transports.length > 6 || credential.transports.some((transport: unknown) =>
          !['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'].includes(String(transport)))))) return null;
    credentials.push({ type: 'public-key', id: credential.id, transports: credential.transports || [] });
  }
  return { challenge: value.challenge, rpId: value.rpId, allowCredentials: credentials,
    timeout: Math.min(180_000, value.timeout ?? 180_000), userVerification: value.userVerification };
}

/** Check the credential's binding before delivering it to the requesting page.
 * The RP still verifies its signature and challenge; this is no success oracle. */
export function validPhonePasskeyCredential(raw: any, request: PhonePasskeyRequest, origin: string): boolean {
  try {
    if (raw?.type !== 'public-key' || !bytes(raw.id, 1, 1024) || raw.id !== raw.rawId
      || (request.allowCredentials.length && !request.allowCredentials.some(c => c.id === raw.id))) return false;
    const response = raw.response;
    const data = bytes(response?.clientDataJSON, 1, 16_384);
    const auth = bytes(response?.authenticatorData, 37, 8192);
    if (!data || !auth || !bytes(response?.signature, 1, 8192)
      || (response.userHandle != null && !bytes(response.userHandle, 1, 64))) return false;
    const client = JSON.parse(data.toString('utf8'));
    if (client.type !== 'webauthn.get' || client.origin !== origin || client.challenge !== request.challenge
      || client.crossOrigin !== false || client.topOrigin !== undefined) return false;
    const rpHash = createHash('sha256').update(request.rpId).digest();
    return auth.subarray(0, 32).equals(rpHash) && !!(auth[32] & 1)
      && (request.userVerification !== 'required' || !!(auth[32] & 4));
  } catch { return false; }
}
