import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

export type OutboundDeliveryCommitHook = () => Promise<void>;

const log = createSubsystemLogger("outbound/deliver");
const outboundDeliveryCommitHooks = new WeakMap<
  OutboundDeliveryResult,
  OutboundDeliveryCommitHook[]
>();

export function attachOutboundDeliveryCommitHook<T extends OutboundDeliveryResult>(
  result: T,
  hook?: OutboundDeliveryCommitHook,
): T {
  if (!hook) {
    return result;
  }
  const hooks = outboundDeliveryCommitHooks.get(result) ?? [];
  hooks.push(hook);
  outboundDeliveryCommitHooks.set(result, hooks);
  return result;
}

export async function runOutboundDeliveryCommitHooks(
  results: readonly OutboundDeliveryResult[],
): Promise<void> {
  for (const result of results) {
    for (const hook of outboundDeliveryCommitHooks.get(result) ?? []) {
      try {
        await hook();
      } catch (err) {
        log.warn("Plugin message adapter after-commit hook failed.", {
          channel: result.channel,
          messageId: result.messageId,
          error: formatErrorMessage(err),
        });
      }
    }
  }
}

export function isOutboundDeliveryResultArray(value: unknown): value is OutboundDeliveryResult[] {
  return Array.isArray(value);
}
