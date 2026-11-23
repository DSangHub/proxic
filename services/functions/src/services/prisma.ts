import { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;
export function getPrismaClient() {
  return client ??= new PrismaClient();
}
