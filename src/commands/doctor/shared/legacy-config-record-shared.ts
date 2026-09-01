// Shared record helpers for legacy config migration modules.
import { isRecord } from "../../../utils.js";
type JsonRecord = Record<string, unknown>;

export type { JsonRecord };
export { isRecord };

/** Clone a record-like config section, treating undefined as an empty object. */
export function cloneRecord<T extends JsonRecord>(value: T | undefined): T {
  return { ...value } as T;
}

/** Own-property guard used by migrations that must preserve falsy values. */
export function hasOwnKey(target: JsonRecord, key: string): boolean {
  return Object.hasOwn(target, key);
}

/** Delete a nested retired config path, with `*` matching record entries. */
export function deleteRetiredPath(owner: unknown, path: readonly string[], index = 0): boolean {
  if (!isRecord(owner)) {
    return false;
  }
  const key = path[index];
  if (!key) {
    return false;
  }
  if (key === "*") {
    let changed = false;
    for (const value of Object.values(owner)) {
      changed = deleteRetiredPath(value, path, index + 1) || changed;
    }
    return changed;
  }
  if (index === path.length - 1) {
    if (!Object.hasOwn(owner, key)) {
      return false;
    }
    delete owner[key];
    return true;
  }
  const child = owner[key];
  if (!isRecord(child) || !deleteRetiredPath(child, path, index + 1)) {
    return false;
  }
  if (Object.keys(child).length === 0) {
    delete owner[key];
  }
  return true;
}

/** Visit agent defaults and both persisted roster shapes in config order. */
export function visitAgentConfigScopes(
  raw: JsonRecord,
  visitor: (scope: JsonRecord, path: string) => void,
  options: { includeDefaults?: boolean; listPathStyle?: "brackets" | "dots" } = {},
): void {
  const agents = raw.agents;
  if (!isRecord(agents)) {
    return;
  }
  if (options.includeDefaults !== false && isRecord(agents.defaults)) {
    visitor(agents.defaults, "agents.defaults");
  }
  if (isRecord(agents.entries)) {
    for (const [agentId, value] of Object.entries(agents.entries)) {
      if (isRecord(value)) {
        visitor(value, `agents.entries.${agentId}`);
      }
    }
  }
  if (!Array.isArray(agents.list)) {
    return;
  }
  agents.list.forEach((value, index) => {
    if (isRecord(value)) {
      const path =
        options.listPathStyle === "dots" ? `agents.list.${index}` : `agents.list[${index}]`;
      visitor(value, path);
    }
  });
}

/** Visit a channel root followed by its object-shaped accounts in config order. */
export function visitChannelEntries(
  raw: JsonRecord,
  channelId: string,
  visitor: (entry: JsonRecord, path: string) => void,
): void {
  const channels = raw.channels;
  if (!isRecord(channels)) {
    return;
  }
  const channel = channels[channelId];
  if (!isRecord(channel)) {
    return;
  }
  visitor(channel, `channels.${channelId}`);
  if (!isRecord(channel.accounts)) {
    return;
  }
  for (const [accountId, account] of Object.entries(channel.accounts)) {
    if (isRecord(account)) {
      visitor(account, `channels.${channelId}.accounts.${accountId}`);
    }
  }
}
