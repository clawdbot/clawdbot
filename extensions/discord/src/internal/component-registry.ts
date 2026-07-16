import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { parseCustomId } from "./components.js";
import type { Message } from "./structures.js";

type OneOffComponentResult =
  | { success: true; customId: string; message: Message; values?: string[] }
  | { success: false; message: Message; reason: "timed out" };

export class ComponentRegistry<
  T extends { customId: string; customIdParser?: typeof parseCustomId; type?: number },
> {
  private entries = new Map<string, T[]>();
  private oneOffComponents = new Map<
    string,
    { message: Message; resolve(result: OneOffComponentResult): void; timer: NodeJS.Timeout }
  >();
  private wildcardEntries: T[] = [];

  register(entry: T): void {
    const key = parseRegistryKey(entry.customId, entry.customIdParser);
    if (key === "*") {
      if (!this.wildcardEntries.includes(entry)) {
        this.wildcardEntries.push(entry);
      }
      return;
    }
    const entries = this.entries.get(key) ?? [];
    if (!entries.includes(entry)) {
      entries.push(entry);
      this.entries.set(key, entries);
    }
  }

  resolve(customId: string, options?: { componentType?: number }): T | undefined {
    for (const entries of this.entries.values()) {
      const match = entries.find((entry) => {
        if (options?.componentType !== undefined && entry.type !== options.componentType) {
          return false;
        }
        const parser = entry.customIdParser ?? parseCustomId;
        return parseRegistryKey(entry.customId, parser) === parseRegistryKey(customId, parser);
      });
      if (match) {
        return match;
      }
    }
    return this.wildcardEntries.find((entry) => {
      if (options?.componentType !== undefined && entry.type !== options.componentType) {
        return false;
      }
      return true;
    });
  }

  waitForMessageComponent(message: Message, timeoutMs: number): Promise<OneOffComponentResult> {
    const key = createOneOffComponentKey(message.id, message.channelId);
    return new Promise((resolve) => {
      const existing = this.oneOffComponents.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve({ success: false, message, reason: "timed out" });
      }
      const timer = setTimeout(
        () => {
          this.oneOffComponents.delete(key);
          resolve({ success: false, message, reason: "timed out" });
        },
        resolveTimerTimeoutMs(timeoutMs, 0, 0),
      );
      timer.unref?.();
      this.oneOffComponents.set(key, {
        message,
        timer,
        resolve,
      });
    });
  }

  resolveOneOffComponent(params: {
    channelId?: string;
    customId: string;
    messageId?: string;
    values?: string[];
  }): boolean {
    if (!params.messageId || !params.channelId) {
      return false;
    }
    const key = createOneOffComponentKey(params.messageId, params.channelId);
    const entry = this.oneOffComponents.get(key);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.oneOffComponents.delete(key);
    entry.resolve({
      success: true,
      customId: params.customId,
      message: entry.message,
      values: params.values,
    });
    return true;
  }
}

function parseRegistryKey(customId: string, parser: typeof parseCustomId = parseCustomId): string {
  return parser(customId).key;
}

function createOneOffComponentKey(messageId: string, channelId: string): string {
  return `${messageId}:${channelId}`;
}
