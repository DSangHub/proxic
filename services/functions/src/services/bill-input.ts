import { createHash } from 'node:crypto';

export class InvalidBillError extends Error {}

export interface BillInput {
  merchant: string;
  amountMinor: number;
  currency: string;
  dueDate: Date;
  accountLastFour: string | null;
  fingerprint: string;
}

export function parseBillInput(value: unknown): BillInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidBillError('Invalid bill');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['merchant', 'amountMinor', 'currency', 'dueDate', 'accountLastFour']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new InvalidBillError('Unexpected bill field');
  if (typeof input.merchant !== 'string') throw new InvalidBillError('Invalid merchant');
  const merchant = input.merchant.trim().normalize('NFKC').replace(/\s+/g, ' ');
  if (merchant.length < 1 || merchant.length > 80 || !/^[\p{L}\p{M}0-9 &'.,-]+$/u.test(merchant) ||
      (merchant.match(/[0-9]/g)?.length ?? 0) > 3 ||
      /\b(?:password|passcode|cvv|cvc|pin|routing|iban|account number|card number)\b/i.test(merchant)) {
    throw new InvalidBillError('Invalid merchant');
  }
  if (typeof input.amountMinor !== 'number' || !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0 || input.amountMinor > 2147483647) throw new InvalidBillError('Invalid amount');
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) throw new InvalidBillError('Invalid currency');
  if (typeof input.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new InvalidBillError('Invalid due date');
  const dueDate = new Date(`${input.dueDate}T00:00:00.000Z`);
  if (Number.isNaN(dueDate.getTime()) || dueDate.toISOString().slice(0, 10) !== input.dueDate) throw new InvalidBillError('Invalid due date');
  if (input.accountLastFour !== undefined && input.accountLastFour !== null &&
      (typeof input.accountLastFour !== 'string' || !/^\d{4}$/.test(input.accountLastFour))) {
    throw new InvalidBillError('Invalid account last four');
  }
  const accountLastFour = (input.accountLastFour as string | null | undefined) ?? null;
  const fingerprint = createHash('sha256').update(JSON.stringify([
    merchant.toLocaleLowerCase('en-US'), input.amountMinor, input.currency, input.dueDate, accountLastFour,
  ])).digest('hex');
  return { merchant, amountMinor: input.amountMinor, currency: input.currency, dueDate, accountLastFour, fingerprint };
}
