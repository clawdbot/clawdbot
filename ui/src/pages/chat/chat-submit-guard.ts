import { generateUUID } from "../../lib/uuid.ts";
import type { ChatHost } from "./chat-send-contract.ts";

const submissionActionIds = new WeakMap<Event, string>();

export function yieldChatSubmitToInput(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener(
      "message",
      () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      },
      { once: true },
    );
    channel.port1.start();
    channel.port2.postMessage(undefined);
  });
}

export async function withChatSubmitGuard<T>(
  host: ChatHost,
  key: string,
  run: () => Promise<T>,
  action?: Event,
): Promise<T | undefined> {
  let guardKey = key;
  if (action) {
    const actionId = submissionActionIds.get(action) ?? generateUUID();
    submissionActionIds.set(action, actionId);
    guardKey = `${key}\0${actionId}`;
  }
  const guards = (host.chatSubmitGuards ??= new Map<string, Promise<void>>());
  if (guards.has(guardKey)) {
    return undefined;
  }
  let releaseGuard!: () => void;
  const guard = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  guards.set(guardKey, guard);
  try {
    return await run();
  } finally {
    releaseGuard();
    if (guards.get(guardKey) === guard) {
      guards.delete(guardKey);
    }
  }
}
