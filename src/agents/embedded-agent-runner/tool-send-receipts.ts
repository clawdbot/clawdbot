import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";

type EmbeddedToolReceiptResult = {
  details: {
    toolSend?: unknown;
    messageDelivery?: unknown;
  };
};

const registry = createSessionManagerRuntimeRegistry<Map<string, EmbeddedToolReceiptResult>>();

export function recordEmbeddedToolReceipt(
  sessionManager: unknown,
  toolCallId: string,
  details: unknown,
  includeMessageDelivery: boolean,
): void {
  const record = asOptionalRecord(details);
  const snapshot = (value: unknown) => {
    const valueRecord = asOptionalRecord(value);
    return valueRecord ? { ...valueRecord } : value;
  };
  const toolSend = record?.toolSend;
  const messageDelivery = includeMessageDelivery ? record?.messageDelivery : undefined;
  if (toolSend === undefined && messageDelivery === undefined) {
    return;
  }
  const receipts = registry.get(sessionManager) ?? new Map<string, EmbeddedToolReceiptResult>();
  receipts.set(toolCallId, {
    details: {
      ...(toolSend !== undefined ? { toolSend: snapshot(toolSend) } : {}),
      ...(messageDelivery !== undefined ? { messageDelivery: snapshot(messageDelivery) } : {}),
    },
  });
  registry.set(sessionManager, receipts);
}

export function consumeEmbeddedToolReceipt(
  sessionManager: unknown,
  toolCallId: string,
): EmbeddedToolReceiptResult | undefined {
  const receipts = registry.get(sessionManager);
  const receipt = receipts?.get(toolCallId);
  if (!receipts || !receipt) {
    return undefined;
  }
  receipts.delete(toolCallId);
  if (receipts.size === 0) {
    registry.set(sessionManager, null);
  }
  return receipt;
}
