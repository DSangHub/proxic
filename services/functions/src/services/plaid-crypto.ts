import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(): Buffer {
  const encoded = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  if (!encoded || !/^[0-9a-f]{64}$/i.test(encoded)) {
    throw new Error('PLAID_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as hex');
  }
  return Buffer.from(encoded, 'hex');
}

export function encryptPlaidToken(token: string, ownerUid: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(ownerUid, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptPlaidToken(payload: string, ownerUid: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted Plaid token');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64url'));
  decipher.setAAD(Buffer.from(ownerUid, 'utf8'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}
