/**
 * Dispatches serialized embedded-agent subscription events to specific handlers.
 */
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  handleAgentEnd,
  handleAgentStart,
  handleCompactionEnd,
  handleCompactionStart,
} from "./embedded-agent-subscribe.handlers.lifecycle.js";
import {
  handleMessageEnd,
  handleMessageStart,
} from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import { isSubscribeTranscriptOnlyOpenClawAssistantMessage } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import { handleMessageUpdate } from "./embedded-agent-subscribe.handlers.messages.update.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./embedded-agent-subscribe.handlers.tools.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentMessage } from "./runtime/index.js";
import type { AgentSessionEvent } from "./sessions/index.js";

/** Create the serialized event dispatcher for subscribed embedded-agent sessions. */
export function createEmbeddedAgentSessionEventHandler(ctx: EmbeddedAgentSubscribeContext) {
  const scheduleEvent = (evt: AgentSessionEvent, handler: () => unknown): void | Promise<void> => {
    // Tool-result delivery must settle before later assistant or terminal events;
    // suppression flags would discard those events instead of preserving order.
    const run = () => {
      try {
        if (evt.type !== "message_update") {
          ctx.flushAssistantStream();
        }
        return handler();
      } catch (err) {
        ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
        return undefined;
      }
    };

    const result = ctx.state.pendingEventChain ? ctx.state.pendingEventChain.then(run) : run();
    if (!isPromiseLike(result)) {
      return;
    }

    const task = Promise.resolve(result)
      .then(
        () => {},
        (err: unknown) => {
          ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
        },
      )
      .finally(() => {
        if (ctx.state.pendingEventChain === task) {
          ctx.state.pendingEventChain = null;
        }
      });
    ctx.state.pendingEventChain = task;
    return task;
  };

  const scheduleAttemptEvent = (
    evt: AgentSessionEvent,
    handler: () => void | Promise<void>,
  ): void | Promise<void> => {
    const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
    let message: AgentMessage | undefined;
    if (
      (evt.type === "message_start" ||
        evt.type === "message_update" ||
        evt.type === "message_end") &&
      "message" in evt
    ) {
      // SAFETY: message_start/update/end variants of AgentSessionEvent always type message as AgentMessage; the type checks above rule out every arm that lacks it.
      message = evt.message as AgentMessage | undefined;
    }
    const messageRole = message?.role;
    if (
      evt.type.startsWith("tool_execution_") ||
      (messageRole === "assistant" && !isSubscribeTranscriptOnlyOpenClawAssistantMessage(message))
    ) {
      ctx.noteCompactionReplacementActivity(deliveryGeneration);
    }
    // Forward the scheduled task so terminal events stay awaitable even when the
    // fence drops a handler from a discarded compaction attempt.
    return scheduleEvent(evt, () => {
      if (deliveryGeneration !== ctx.getBlockReplyDeliveryGeneration()) {
        return;
      }
      return handler();
    });
  };

  return (evt: AgentSessionEvent) => {
    // Model facts advance before persistence, independently of queued reply delivery.
    ctx.captureModelEvent(evt);
    switch (evt.type) {
      case "message_start":
        void scheduleAttemptEvent(evt, () => handleMessageStart(ctx, evt));
        return;
      case "message_update": {
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(evt, () => handleMessageUpdate(ctx, evt, { deliveryGeneration }));
        return;
      }
      case "message_end": {
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(evt, () => handleMessageEnd(ctx, evt, { deliveryGeneration }));
        return;
      }
      case "tool_execution_start": {
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(evt, () =>
          handleToolExecutionStart(ctx, evt, { deliveryGeneration }),
        );
        return;
      }
      case "tool_execution_update": {
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(evt, () =>
          handleToolExecutionUpdate(ctx, evt, { deliveryGeneration }),
        );
        return;
      }
      case "tool_execution_end": {
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(evt, async () => {
          await handleToolExecutionEnd(ctx, evt, { deliveryGeneration });
        });
        return;
      }
      case "agent_start":
        void scheduleEvent(evt, () => handleAgentStart(ctx));
        return;
      case "compaction_start":
        void scheduleEvent(evt, () => handleCompactionStart(ctx, evt));
        return;
      case "compaction_end": {
        // A delivery callback from the discarded attempt must not prevent the
        // serialized compaction replacement from reaching its reset handler.
        // Keep each observed compaction's generation token distinct so queued
        // replacement attempts cannot collapse across consecutive compactions.
        const invalidatedDeliveryGeneration =
          evt.outcome.status === "completed" && evt.outcome.willRetry
            ? ctx.invalidateBlockReplyDeliveriesForCompactionRetry()
            : undefined;
        if (invalidatedDeliveryGeneration !== undefined) {
          ctx.noteCompactionRetry(invalidatedDeliveryGeneration);
        }
        // The attempt's replacement hook already recorded its private commit fact.
        // Keep public completion timing and standalone subscriber counting unchanged.
        void scheduleEvent(evt, () => {
          handleCompactionEnd(ctx, {
            ...evt,
            invalidatedDeliveryGeneration,
            retryAlreadyNoted: invalidatedDeliveryGeneration !== undefined,
          });
        });
        return;
      }
      case "agent_end": {
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        return scheduleAttemptEvent(evt, () => {
          return handleAgentEnd(ctx, evt, { deliveryGeneration });
        });
      }
      default:
    }
  };
}
