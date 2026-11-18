import { Prisma, PrismaClient, type PlaidConnectionState } from '@prisma/client';
import { PlaidClient, PlaidEnvironment, PlaidError, type Plaid } from 'plaid';
import { decryptPlaidToken, encryptPlaidToken } from './plaid-crypto.js';

export class PlaidConflictError extends Error {}
export class PlaidNotFoundError extends Error {}
export class PlaidInvalidTokenError extends Error {}

type Connection = { status: PlaidConnectionState; encryptedToken: string };
type LinkedItem = { itemId: string; institutionId: string | null; institutionName: string | null };
export type BankMetadata = {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  accounts: { accountId: string; displayName: string; mask: string | null; type: string; subtype: string | null }[];
};
export type BankConnectionView = {
  status: PlaidConnectionState;
  institutionName: string | null;
  accounts: { accountId: string; mask: string | null; type: string; subtype: string | null }[];
};
export interface ConnectionStore {
  get(ownerUid: string): Promise<Connection | null>;
  getMetadata(ownerUid: string): Promise<BankConnectionView | null>;
  create(ownerUid: string, encryptedToken: string): Promise<void>;
  transition(ownerUid: string, from: PlaidConnectionState, to: PlaidConnectionState, expectedToken: string, encryptedToken?: string, linkedItem?: LinkedItem): Promise<boolean>;
  syncMetadata(ownerUid: string, expectedToken: string, metadata: BankMetadata): Promise<boolean>;
  delete(ownerUid: string, status: PlaidConnectionState, expectedToken: string): Promise<boolean>;
}

export class PrismaConnectionStore implements ConnectionStore {
  constructor(private readonly db: PrismaClient) {}
  get(ownerUid: string) {
    return this.db.plaidConnection.findUnique({ where: { ownerUid }, select: { status: true, encryptedToken: true } });
  }
  getMetadata(ownerUid: string) {
    return this.db.bankConnection.findUnique({
      where: { ownerUid },
      select: {
        status: true, institutionName: true,
        accounts: { select: { accountId: true, mask: true, type: true, subtype: true }, orderBy: { createdAt: 'asc' } },
      },
    });
  }
  async create(ownerUid: string, encryptedToken: string) {
    try {
      await this.db.$transaction(async tx => {
        await tx.plaidConnection.create({ data: { ownerUid, encryptedToken } });
        await tx.bankConnection.create({ data: { ownerUid } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new PlaidConflictError('A connection or Link session already exists');
      }
      throw error;
    }
  }
  async transition(ownerUid: string, from: PlaidConnectionState, to: PlaidConnectionState, expectedToken: string, encryptedToken?: string, linkedItem?: LinkedItem) {
    return this.db.$transaction(async tx => {
      const result = await tx.plaidConnection.updateMany({
        where: { ownerUid, status: from, encryptedToken: expectedToken },
        data: { status: to, ...(encryptedToken === undefined ? {} : { encryptedToken }) },
      });
      if (!result.count) return false;
      await tx.bankConnection.update({
        where: { ownerUid }, data: {
          status: to,
          ...(linkedItem ? {
            plaidItemId: linkedItem.itemId, institutionId: linkedItem.institutionId, institutionName: linkedItem.institutionName,
          } : {}),
        },
      });
      return true;
    });
  }
  async syncMetadata(ownerUid: string, expectedToken: string, metadata: BankMetadata) {
    return this.db.$transaction(async tx => {
      const locked = await tx.plaidConnection.updateMany({
        where: { ownerUid, status: 'ACTIVE', encryptedToken: expectedToken }, data: { status: 'ACTIVE' },
      });
      if (!locked.count) return false;
      const matches = await tx.bankConnection.updateMany({
        where: { ownerUid, status: 'ACTIVE', OR: [{ plaidItemId: null }, { plaidItemId: metadata.itemId }] },
        data: {
          plaidItemId: metadata.itemId,
          institutionId: metadata.institutionId ?? undefined,
          institutionName: metadata.institutionName ?? undefined,
        },
      });
      if (!matches.count) throw new Error('Plaid Item does not match the stored connection');
      const connection = await tx.bankConnection.findUniqueOrThrow({ where: { ownerUid }, select: { id: true } });
      await tx.bankAccount.deleteMany({
        where: { bankConnectionId: connection.id, accountId: { notIn: metadata.accounts.map(account => account.accountId) } },
      });
      for (const account of metadata.accounts) {
        const { accountId, ...details } = account;
        await tx.bankAccount.upsert({
          where: { bankConnectionId_accountId: { bankConnectionId: connection.id, accountId } },
          create: { bankConnectionId: connection.id, accountId, ...details },
          update: details,
        });
      }
      return true;
    });
  }
  async delete(ownerUid: string, status: PlaidConnectionState, expectedToken: string) {
    return (await this.db.plaidConnection.deleteMany({ where: { ownerUid, status, encryptedToken: expectedToken } })).count === 1;
  }
}

export interface PlaidGateway {
  createLink(ownerUid: string): Promise<{ linkToken: string; expiration: string }>;
  linkInstitution(linkToken: string, publicToken: string): Promise<{ institutionId: string | null; institutionName: string | null } | null>;
  exchange(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  accounts(accessToken: string, liveBalance: boolean): Promise<{ itemId: string; institutionId: string | null; institutionName: string | null; accounts: Plaid.AccountBase[] }>;
  remove(accessToken: string): Promise<void>;
}

export class SandboxPlaidGateway implements PlaidGateway {
  private readonly client: PlaidClient;
  constructor() {
    if (process.env.PLAID_ENV && process.env.PLAID_ENV !== 'sandbox') throw new Error('Only Plaid Sandbox is supported');
    const { PLAID_CLIENT_ID: clientId, PLAID_SECRET: secret } = process.env;
    if (!clientId || !secret) throw new Error('Plaid Sandbox credentials are not configured');
    this.client = new PlaidClient({ environment: PlaidEnvironment.Sandbox, clientId, secret, timeoutInSeconds: 30 });
  }
  async createLink(ownerUid: string) {
    const result = await this.client.link.createToken({
      user: { client_user_id: ownerUid }, client_name: 'Proxic', language: 'en', country_codes: ['US'],
      products: ['transactions'],
    });
    return { linkToken: result.link_token, expiration: result.expiration };
  }
  async linkInstitution(linkToken: string, publicToken: string) {
    const result = await this.client.link.getToken({ link_token: linkToken });
    for (const session of result.link_sessions ?? []) {
      const item = session.results?.item_add_results?.find(entry => entry.public_token === publicToken);
      if (item) return { institutionId: item.institution?.institution_id ?? null, institutionName: item.institution?.name ?? null };
      if (session.on_success?.public_token === publicToken) {
        const institution = session.on_success.metadata?.institution;
        return { institutionId: institution?.institution_id ?? null, institutionName: institution?.name ?? null };
      }
    }
    return null;
  }
  async exchange(publicToken: string) {
    const result = await this.client.item.exchangePublicToken({ public_token: publicToken });
    return { accessToken: result.access_token, itemId: result.item_id };
  }
  async accounts(accessToken: string, liveBalance: boolean) {
    const result = liveBalance
      ? await this.client.accounts.getBalance({ access_token: accessToken })
      : await this.client.accounts.get({ access_token: accessToken });
    return {
      itemId: result.item.item_id, institutionId: result.item.institution_id ?? null,
      institutionName: result.item.institution_name ?? null, accounts: result.accounts,
    };
  }
  async remove(accessToken: string) {
    try {
      await this.client.item.remove({ access_token: accessToken });
    } catch (error) {
      if (error instanceof PlaidError && typeof error.body === 'object' && error.body !== null &&
          'error_code' in error.body && error.body.error_code === 'INVALID_ACCESS_TOKEN') return;
      throw error;
    }
  }
}

function safeMask(mask: string | null) {
  return mask && /^[A-Za-z0-9]{2,4}$/.test(mask) ? mask : null;
}

function accountView(account: Plaid.AccountBase) {
  return {
    accountId: account.account_id, name: account.name, mask: safeMask(account.mask),
    type: account.type, subtype: account.subtype,
    balances: {
      available: account.balances.available, current: account.balances.current,
      limit: account.balances.limit, isoCurrencyCode: account.balances.iso_currency_code,
      unofficialCurrencyCode: account.balances.unofficial_currency_code,
    },
  };
}

export class PlaidService {
  constructor(private readonly store: ConnectionStore, private readonly gateway: PlaidGateway) {}

  async connection(ownerUid: string): Promise<BankConnectionView> {
    const connection = await this.store.getMetadata(ownerUid);
    if (!connection) throw new PlaidNotFoundError('Connection not found');
    return { ...connection, accounts: connection.accounts.map(account => ({ ...account, mask: safeMask(account.mask) })) };
  }

  async link(ownerUid: string) {
    if (await this.store.get(ownerUid)) throw new PlaidConflictError('A connection or Link session already exists');
    // Validate the encryption key before issuing a Link token.
    encryptPlaidToken('key-check', ownerUid);
    const result = await this.gateway.createLink(ownerUid);
    if (!result.linkToken.startsWith('link-sandbox-')) throw new Error('Plaid did not issue a Sandbox Link token');
    await this.store.create(ownerUid, encryptPlaidToken(result.linkToken, ownerUid));
    return { linkToken: result.linkToken, expiration: result.expiration };
  }

  async exchange(ownerUid: string, publicToken: string) {
    if (!/^public-sandbox-[A-Za-z0-9-]+$/.test(publicToken)) throw new PlaidInvalidTokenError('Invalid Sandbox public token');
    const connection = await this.store.get(ownerUid);
    if (!connection) throw new PlaidNotFoundError('Link session not found');
    if (connection.status !== 'LINKING') throw new PlaidConflictError('Connection is not awaiting exchange');
    const linkToken = decryptPlaidToken(connection.encryptedToken, ownerUid);
    const institution = await this.gateway.linkInstitution(linkToken, publicToken);
    if (!institution) {
      throw new PlaidInvalidTokenError('Public token does not belong to this Link session');
    }
    if (!await this.store.transition(ownerUid, 'LINKING', 'EXCHANGING', connection.encryptedToken)) throw new PlaidConflictError('Link session is no longer available');
    // An ambiguous exchange failure stays EXCHANGING: the public token may already be consumed.
    const result = await this.gateway.exchange(publicToken);
    if (!result.accessToken.startsWith('access-sandbox-')) throw new Error('Plaid returned a non-Sandbox access token');
    let encryptedAccessToken: string | undefined;
    try {
      encryptedAccessToken = encryptPlaidToken(result.accessToken, ownerUid);
      if (!result.itemId) throw new Error('Plaid did not return an Item identifier');
      if (!await this.store.transition(ownerUid, 'EXCHANGING', 'ACTIVE', connection.encryptedToken, encryptedAccessToken, { itemId: result.itemId, ...institution })) {
        throw new Error('Plaid connection state changed during exchange');
      }
    } catch (error) {
      try {
        await this.gateway.remove(result.accessToken);
        await this.store.delete(ownerUid, 'EXCHANGING', connection.encryptedToken);
        if (encryptedAccessToken) await this.store.delete(ownerUid, 'ACTIVE', encryptedAccessToken);
      } catch {
        throw new Error('Plaid exchange persistence and cleanup failed; manual intervention required');
      }
      throw error;
    }
    // Keep an active encrypted token if metadata retrieval fails; a later accounts request can retry.
    await this.accounts(ownerUid, false);
  }

  async accounts(ownerUid: string, liveBalance: boolean) {
    const connection = await this.store.get(ownerUid);
    if (!connection) throw new PlaidNotFoundError('Connection not found');
    if (connection.status !== 'ACTIVE') throw new PlaidConflictError('Connection is not active');
    const token = decryptPlaidToken(connection.encryptedToken, ownerUid);
    if (!token.startsWith('access-sandbox-')) throw new Error('Invalid stored Sandbox token');
    const result = await this.gateway.accounts(token, liveBalance);
    if (!result.itemId) throw new Error('Plaid did not return an Item identifier');
    const metadata: BankMetadata = {
      itemId: result.itemId, institutionId: result.institutionId, institutionName: result.institutionName,
      accounts: result.accounts.map(account => ({
        accountId: account.account_id, displayName: account.name, mask: safeMask(account.mask),
        type: account.type, subtype: account.subtype,
      })),
    };
    if (!await this.store.syncMetadata(ownerUid, connection.encryptedToken, metadata)) {
      throw new PlaidConflictError('Connection state changed');
    }
    return result.accounts.map(accountView);
  }

  async disconnect(ownerUid: string) {
    const connection = await this.store.get(ownerUid);
    if (!connection) throw new PlaidNotFoundError('Connection not found');
    if (connection.status === 'LINKING') {
      if (!await this.store.delete(ownerUid, 'LINKING', connection.encryptedToken)) throw new PlaidConflictError('Connection state changed');
      return;
    }
    if (connection.status === 'EXCHANGING') throw new PlaidConflictError('Connection exchange is in progress or requires support');
    if (connection.status === 'ACTIVE' && !await this.store.transition(ownerUid, 'ACTIVE', 'DISCONNECTING', connection.encryptedToken)) {
      throw new PlaidConflictError('Connection state changed');
    }
    const token = decryptPlaidToken(connection.encryptedToken, ownerUid);
    if (!token.startsWith('access-sandbox-')) throw new Error('Invalid stored Sandbox token');
    await this.gateway.remove(token);
    await this.store.delete(ownerUid, 'DISCONNECTING', connection.encryptedToken);
  }
}

let service: PlaidService | undefined;
export function getPlaidService() {
  if (!service) service = new PlaidService(new PrismaConnectionStore(new PrismaClient()), new SandboxPlaidGateway());
  return service;
}
