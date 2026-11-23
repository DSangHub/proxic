import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { InvalidBillError, parseBillInput, type BillInput } from './bill-input.js';
import { propose } from './propose.js';
import { getPrismaClient } from './prisma.js';

const domain = 'in.proxic.app';
const aliasPattern = /^b\.([A-Za-z0-9_-]{43})@in\.proxic\.app$/;

function key() {
  const value = process.env.FORWARDING_ALIAS_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('FORWARDING_ALIAS_ENCRYPTION_KEY must be 32 bytes in hex');
  return Buffer.from(value, 'hex');
}
export function newAliasToken() { return randomBytes(32).toString('base64url'); }
export function aliasHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function parseAlias(address: string) { return aliasPattern.exec(address)?.[1] ?? null; }
function encrypt(token: string, ownerUid: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(ownerUid));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}
function decrypt(value: string, ownerUid: string) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted alias');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[0], 'base64url'));
  decipher.setAAD(Buffer.from(ownerUid));
  decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
}
const address = (token: string) => `b.${token}@${domain}`;
async function audit(tx: Prisma.TransactionClient, ownerUid: string, action: string, resource: string, billId?: string) {
  await tx.auditEvent.create({ data: { actor: ownerUid, ownerUid, action, resource, billId } });
}

export type Attachment = { fileName: string; contentType: string; storageReference: string; scanStatus: 'clean' | 'pending' | 'malicious' | 'failed' };
export type IngestPayload = { recipientAlias: string; sender: string; subject: string; receivedAt: Date; textContent: string; attachments: Attachment[] };
export class InvalidIngestionError extends Error {}

function bounded(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) && !value.includes('\0');
}
export function validateIngestion(raw: unknown): IngestPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidIngestionError('Invalid payload');
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).some(k => !['recipientAlias', 'sender', 'subject', 'receivedAt', 'textContent', 'attachments'].includes(k)) ||
      !bounded(v.recipientAlias, 100) || !parseAlias(v.recipientAlias) ||
      !bounded(v.sender, 320) || !bounded(v.subject, 998, true) ||
      !bounded(v.receivedAt, 40) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v.receivedAt) ||
      !Number.isFinite(Date.parse(v.receivedAt)) ||
      new Date(v.receivedAt).toISOString().slice(0, 19) !== v.receivedAt.slice(0, 19) || !bounded(v.textContent, 100000, true) ||
      !Array.isArray(v.attachments) || v.attachments.length > 20) throw new InvalidIngestionError('Invalid payload');
  const attachments: Attachment[] = v.attachments.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new InvalidIngestionError('Invalid attachment');
    const a = item as Record<string, unknown>;
    if (Object.keys(a).some(k => !['fileName', 'contentType', 'storageReference', 'scanStatus'].includes(k)) ||
        !bounded(a.fileName, 255) || !bounded(a.contentType, 100) ||
        !bounded(a.storageReference, 1024) ||
        !/^quarantine\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(a.storageReference) ||
        a.storageReference.split('/').some(part => part === '.' || part === '..' || part === '') ||
        typeof a.scanStatus !== 'string' || !['clean', 'pending', 'malicious', 'failed'].includes(a.scanStatus)) {
      throw new InvalidIngestionError('Invalid attachment');
    }
    return { fileName: a.fileName, contentType: a.contentType, storageReference: a.storageReference, scanStatus: a.scanStatus as Attachment['scanStatus'] };
  });
  return { recipientAlias: v.recipientAlias, sender: v.sender, subject: v.subject, receivedAt: new Date(v.receivedAt), textContent: v.textContent, attachments };
}

export interface ParsedBill {
  merchant: string | null;
  amountCents: number | null;
  currency: string | null;
  dueDate: string | null;
  accountLast4: string | null;
  confidence: number;
}
export interface BillParser { parse(text: string): Promise<ParsedBill>; }

// Development parser deliberately accepts only explicit, unambiguous labelled fields.
export class MockBillParser implements BillParser {
  async parse(text: string): Promise<ParsedBill> {
    const get = (name: string) => {
      const matches = [...text.matchAll(new RegExp(`^${name}:[ \\t]*([^\\r\\n]+?)[ \\t]*$`, 'gim'))];
      return matches.length === 1 ? matches[0][1].trim() : null;
    };
    const amount = get('Amount');
    const match = amount && /^(\d{1,7})\.(\d{2})$/.exec(amount);
    const merchant = get('Merchant'), currency = get('Currency'), dueDate = get('Due Date'), accountLast4 = get('Account Last 4');
    const amountCents = match ? Number(match[1]) * 100 + Number(match[2]) : null;
    return { merchant, amountCents, currency, dueDate, accountLast4, confidence: merchant && amountCents && currency && dueDate ? 1 : 0 };
  }
}

function normalized(parsed: ParsedBill): BillInput | null {
  // The mock parser interprets amounts as cents; avoid guessing other currencies' minor units.
  if (parsed.currency !== 'USD') return null;
  try {
    return parseBillInput({ merchant: parsed.merchant, amountMinor: parsed.amountCents, currency: parsed.currency,
      dueDate: parsed.dueDate, accountLastFour: parsed.accountLast4 });
  } catch (error) {
    if (error instanceof InvalidBillError) return null;
    throw error;
  }
}

export class ForwardingStore {
  constructor(private readonly db: PrismaClient, private readonly parser: BillParser = new MockBillParser()) {}

  async current(ownerUid: string) {
    const row = await this.db.forwardingAlias.findFirst({ where: { ownerUid, active: true, purpose: 'bill' } });
    if (!row) return null;
    if (!row.encryptedToken) throw new Error('Active alias has no encrypted token');
    return address(decrypt(row.encryptedToken, ownerUid));
  }
  async change(ownerUid: string, operation: 'create' | 'rotate' | 'revoke') {
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerUid}, 0))`;
      const existing = await tx.forwardingAlias.findFirst({ where: { ownerUid, active: true, purpose: 'bill' } });
      if (operation === 'create' && existing) {
        if (!existing.encryptedToken) throw new Error('Active alias has no encrypted token');
        return address(decrypt(existing.encryptedToken, ownerUid));
      }
      if (operation !== 'create' && !existing) return null;
      const now = new Date();
      if (existing) await tx.forwardingAlias.update({ where: { id: existing.id }, data: {
        active: false, revokedAt: now, encryptedToken: null, ...(operation === 'rotate' ? { rotatedAt: now } : {}),
      } });
      if (operation === 'revoke') {
        await audit(tx, ownerUid, 'forwarding_alias.revoked', `forwarding_alias:${existing!.id}`);
        return null;
      }
      const token = newAliasToken();
      const row = await tx.forwardingAlias.create({ data: { ownerUid, aliasHash: aliasHash(token), encryptedToken: encrypt(token, ownerUid),
        ...(operation === 'rotate' ? { rotatedAt: now } : {}) } });
      await audit(tx, ownerUid, operation === 'rotate' ? 'forwarding_alias.rotated' : 'forwarding_alias.created', `forwarding_alias:${row.id}`);
      return address(token);
    });
  }
  async recent(ownerUid: string) {
    return this.db.billSubmission.findMany({
      where: { ownerUid, source: 'FORWARDED_EMAIL' }, orderBy: { createdAt: 'desc' }, take: 25,
      select: { id: true, processingStatus: true, receivedAt: true, bill: { select: { merchant: true, amountMinor: true, currency: true, dueDate: true } } },
    });
  }
  async ingest(payload: IngestPayload) {
    const token = parseAlias(payload.recipientAlias);
    if (!token) throw new InvalidIngestionError('Invalid alias');
    return this.db.$transaction(async tx => {
      // Row lock serializes ingestion against revocation and rotation.
      const rows = await tx.$queryRaw<{ id: string; ownerUid: string }[]>`SELECT "id", "ownerUid" FROM "ForwardingAlias" WHERE "aliasHash" = ${aliasHash(token)} AND "active" = true AND "purpose" = 'bill' FOR UPDATE`;
      const alias = rows[0];
      if (!alias) return { kind: 'unknown' as const };
      const ownerUid = alias.ownerUid;
      const status = payload.attachments.some(a => a.scanStatus === 'malicious') ? 'malicious' :
        payload.attachments.some(a => a.scanStatus === 'failed') ? 'failed' :
        payload.attachments.some(a => a.scanStatus !== 'clean') ? 'pending' : payload.attachments.length ? 'clean' : 'not_applicable';
      const submission = await tx.billSubmission.create({ data: {
        ownerUid, source: 'FORWARDED_EMAIL', sender: payload.sender, subject: payload.subject, receivedAt: payload.receivedAt,
        processedAt: null, processingStatus: 'received', scanStatus: status, attachments: payload.attachments,
      } });
      const resource = `bill_submission:${submission.id}`;
      await audit(tx, ownerUid, 'email.received', resource);
      if (payload.attachments.length) {
        await audit(tx, ownerUid, 'attachment.quarantined', resource);
        if (payload.attachments.some(a => a.scanStatus !== 'pending')) await audit(tx, ownerUid, 'malware_scan.result_received', resource);
      }
      if (status === 'malicious' || status === 'pending' || status === 'failed') {
        const processingStatus = status === 'malicious' ? 'rejected' : 'quarantined';
        await tx.billSubmission.update({ where: { id: submission.id }, data: { processingStatus } });
        if (status === 'malicious') await audit(tx, ownerUid, 'bill.rejected', resource);
        return { kind: processingStatus, id: submission.id };
      }
      await tx.billSubmission.update({ where: { id: submission.id }, data: { processingStatus: 'processing' } });
      const parsed = await this.parser.parse(payload.textContent);
      await audit(tx, ownerUid, 'bill.parsed', resource);
      const input = normalized(parsed);
      if (!input) {
        await tx.billSubmission.update({ where: { id: submission.id }, data: { processingStatus: 'needs_review', processedAt: new Date() } });
        return { kind: 'needs_review' as const, id: submission.id };
      }
      const action = propose('bill', 'pay bill');
      if (!action.requiresApproval || action.riskLevel < 3 || action.status !== 'awaiting_approval') throw new Error('Bill approval policy invariant violated');
      const inserted = await tx.bill.createMany({ data: [{ ownerUid, ...input, source: 'FORWARDED_EMAIL',
        riskLevel: action.riskLevel, approvalRequired: true }], skipDuplicates: true });
      const bill = await tx.bill.findUniqueOrThrow({ where: { ownerUid_fingerprint: { ownerUid, fingerprint: input.fingerprint } } });
      const duplicate = inserted.count === 0;
      await tx.billSubmission.update({ where: { id: submission.id }, data: {
        billId: bill.id, processingStatus: duplicate ? 'duplicate' : 'processed', processedAt: new Date(),
      } });
      if (duplicate) {
        await audit(tx, ownerUid, 'bill.possible_duplicate', resource, bill.id);
      } else {
        await tx.approval.create({ data: { ownerUid, billId: bill.id, status: 'pending', proposedAction: {
          id: action.id, proxy: action.proxy, action: action.action, description: action.description, riskLevel: action.riskLevel,
          requiresApproval: action.requiresApproval, status: action.status, payload: {}, createdAt: action.createdAt,
        } } });
        await audit(tx, ownerUid, 'bill.matched', resource, bill.id);
        await audit(tx, ownerUid, 'bill.created', resource, bill.id);
      }
      return { kind: duplicate ? 'duplicate' : 'processed', id: submission.id };
    });
  }
}

let store: ForwardingStore | undefined;
export function getForwardingStore() { return store ??= new ForwardingStore(getPrismaClient()); }
