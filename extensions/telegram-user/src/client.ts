import { TelegramClient } from "@mtcute/node";

export function createTelegramUserClient(params: {
  apiId: number;
  apiHash: string;
  storagePath: string;
}) {
  return new TelegramClient({
    apiId: params.apiId,
    apiHash: params.apiHash,
    storage: params.storagePath,
  });
}
