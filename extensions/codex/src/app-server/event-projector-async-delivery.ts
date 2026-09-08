import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerEventProjectorOptions } from "./event-projector-options.js";
import type { CodexThreadItem } from "./protocol.js";

type CodexAsyncDelivery = Parameters<
  NonNullable<CodexAppServerEventProjectorOptions["onAsyncDelivery"]>
>[0];

/** Owns authorization, exactly-once settlement, and terminal retry for async user messages. */
export class CodexAsyncDeliveryProjection {
  private readonly settledItemIds = new Set<string>();
  private readonly pendingDeliveries = new Map<string, CodexAsyncDelivery>();

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly options: CodexAppServerEventProjectorOptions,
  ) {}

  allows(item: CodexThreadItem | undefined, reportUnauthorized = false): boolean {
    if (item?.type !== "agentMessage" || item.delivery !== "async") {
      return true;
    }
    const allowed =
      this.params.disableTools !== true &&
      (this.options.asyncUserMessageAllowed ??
        (this.params.toolsAllow === undefined ||
          this.params.toolsAllow.some((name) => name === "*" || name === "message")));
    if (!allowed && reportUnauthorized) {
      embeddedAgentLog.warn("blocked unauthorized codex async user message", {
        itemId: item.id,
        threadId: this.threadId,
        turnId: this.turnId,
      });
    }
    return allowed;
  }

  pending(): CodexAsyncDelivery[] {
    return [...this.pendingDeliveries.values()];
  }

  async deliver(delivery: CodexAsyncDelivery): Promise<void> {
    if (this.settledItemIds.has(delivery.itemId)) {
      return;
    }
    const settlement = await this.options.onAsyncDelivery?.(delivery);
    if (settlement === "settled") {
      this.settledItemIds.add(delivery.itemId);
      this.pendingDeliveries.delete(delivery.itemId);
    } else if (settlement === "retry") {
      this.pendingDeliveries.set(delivery.itemId, delivery);
    }
  }
}
