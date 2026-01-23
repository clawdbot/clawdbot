import type { TelegramClient } from "@mtcute/node";

let activeClient: TelegramClient | null = null;

export function setActiveTelegramUserClient(next: TelegramClient | null) {
  activeClient = next;
}

export function getActiveTelegramUserClient(): TelegramClient | null {
  return activeClient;
}
