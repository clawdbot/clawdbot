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
  capturePendingAssistantUsage,
  preservePendingAssistantUsage,
  resetPendingAssistantUsage,
} from "./embedded-agent-subscribe.handlers.messages.lifecycle-state.js";
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
  const scheduleEvent = (
    evt: AgentSessionEvent,
    handler: () => void | Promise<void>,
    options?: { detach?: boolean },
  ): void | Promise<void> => {
    // Most stream events must preserve order across async formatting and flush
    // work. A detached event may run after the chain without blocking delivery.
    const run = () => {
      try {
        return handler();
      } catch (err) {
        ctx.log.debug(evt.type + " handler failed: " + String(err));
      }
    };

    if (!ctx.state.pendingEventChain) {
      const result = run();
      if (!isPromiseLike<void>(result)) {
        return;
      }
      const task = result
        .catch((err: unknown) => {
          ctx.log.debug(evt.type + " handler failed: " + String(err));
        })
        .finally(() => {
          if (ctx.state.pendingEventChain === task) {
            ctx.state.pendingEventChain = null;
          }
        });
      if (!options?.detach) {
        ctx.state.pendingEventChain = task;
        return task;
      }
      return;
    }

    const task = ctx.state.pendingEventChain
      .then(() => run())
      .catch((err: unknown) => {
        ctx.log.debug(evt.type + " handler failed: " + String(err));
      })
      .finally(() => {
        if (ctx.state.pendingEventChain === task) {
          ctx.state.pendingEventChain = null;
        }
      });
    if (!options?.detach) {
      ctx.state.pendingEventChain = task;
      return task;
    }
  };

  const scheduleAttemptEvent = (
    evt: AgentSessionEvent,
    handler: () => void | Promise<void>,
    options?: { detach?: boolean },
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
    return scheduleEvent(
      evt,
      () => {
        if (deliveryGeneration !== ctx.getBlockReplyDeliveryGeneration()) {
          return;
        }
        return handler();
      },
      options,
    );
  };

  return (evt: AgentSessionEvent) => {
    switch (evt.type) {
      case "message_start":
        // Delivery from the previous message may still be queued, but usage is
        // message-scoped. Reset only its accounting boundary synchronously so
        // this message's streamed usage cannot inherit the prior commit state.
        resetPendingAssistantUsage(ctx, evt.message as AgentMessage);
        void scheduleAttemptEvent(evt, () => {
          handleMessageStart(ctx, evt as never);
        });
        return;
      case "message_update": {
        // AgentSession persists message_end after this listener returns, while
        // delivery handlers may still be queued. Capture usage synchronously so
        // the following final snapshot can be repaired before persistence.
        capturePendingAssistantUsage(ctx, evt as never);
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(evt, () =>
          handleMessageUpdate(ctx, evt as never, { deliveryGeneration }),
        );
        return;
      }
      case "message_end": {
        if ((evt.message as AgentMessage)?.role === "assistant") {
          preservePendingAssistantUsage(
            evt.message as Extract<AgentMessage, { role: "assistant" }>,
            ctx.state.pendingAssistantUsage,
          );
        }
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(evt, () => {
          return handleMessageEnd(ctx, evt as never, { deliveryGeneration });
        });
        return;
      }
      case "tool_execution_start": {
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(evt, () => {
          return handleToolExecutionStart(ctx, evt as never, { deliveryGeneration });
        });
        return;
      }
      case "tool_execution_update": {
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(evt, () => {
          handleToolExecutionUpdate(ctx, evt as never, { deliveryGeneration });
        });
        return;
      }
      case "tool_execution_end": {
        const deliveryGeneration = ctx.getBlockReplyDeliveryGeneration();
        void scheduleAttemptEvent(
          evt,
          () => {
            return handleToolExecutionEnd(ctx, evt as never, { deliveryGeneration });
          },
          { detach: true },
        );
        return;
      }
      case "agent_start":
        void scheduleEvent(evt, () => {
          handleAgentStart(ctx);
        });
        return;
      case "compaction_start":
        void scheduleEvent(evt, () => {
          handleCompactionStart(ctx, {
            type: "compaction_start",
            reason: evt.reason,
          });
        });
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
          return handleAgentEnd(ctx, evt as never, { deliveryGeneration });
        });
      }
      default:
    }
  };
}
