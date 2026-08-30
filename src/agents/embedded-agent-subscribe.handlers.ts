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
  handleMessageStart,
  preservePendingAssistantUsage,
  resetPendingAssistantUsage,
  handleMessageEnd,
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
import { deriveSessionTotalTokens, normalizeUsage } from "./usage.js";

/** Create the serialized event dispatcher for subscribed embedded-agent sessions. */
export function createEmbeddedAgentSessionEventHandler(ctx: EmbeddedAgentSubscribeContext) {
  const scheduleEvent = (
    evt: AgentSessionEvent,
    handler: () => void | Promise<void>,
  ): void | Promise<void> => {
    // Tool-result delivery must settle before later assistant or terminal events;
    // suppression flags would discard those events instead of preserving order.
    const run = () => {
      try {
        return handler();
      } catch (err) {
        ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
      }
    };

    if (!ctx.state.pendingEventChain) {
      const result = run();
      if (!isPromiseLike<void>(result)) {
        return;
      }
      const task = result
        .catch((err: unknown) => {
          ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
        })
        .finally(() => {
          if (ctx.state.pendingEventChain === task) {
            ctx.state.pendingEventChain = null;
          }
        });
      ctx.state.pendingEventChain = task;
      return task;
    }

    const task = ctx.state.pendingEventChain
      .then(() => run())
      .catch((err: unknown) => {
        ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
      })
      .finally(() => {
        if (ctx.state.pendingEventChain === task) {
          ctx.state.pendingEventChain = null;
        }
      });
    ctx.state.pendingEventChain = task;
    return task;
  };

  return (evt: AgentSessionEvent) => {
    switch (evt.type) {
      case "message_start":
        // Delivery from the previous message may still be queued, but usage is
        // message-scoped. Reset only its accounting boundary synchronously so
        // this message's streamed usage cannot inherit the prior commit state.
        resetPendingAssistantUsage(ctx, evt.message as AgentMessage);
        void scheduleEvent(evt, () => {
          handleMessageStart(ctx, evt as never);
        });
        return;
      case "message_update":
        // AgentSession persists message_end after this listener returns, while
        // delivery handlers may still be queued. Capture usage synchronously so
        // the following final snapshot can be repaired before persistence.
        capturePendingAssistantUsage(ctx, evt as never);
        void scheduleEvent(evt, () => {
          handleMessageUpdate(ctx, evt as never);
        });
        return;
      case "message_end": {
        const message = evt.message as AgentMessage;
        if (message?.role === "assistant") {
          preservePendingAssistantUsage(message, ctx.state.pendingAssistantUsage);
          if (!isSubscribeTranscriptOnlyOpenClawAssistantMessage(message)) {
            // Delivery may still be queued when compaction replaces the context.
            // Capture this message's usage now, including an explicitly unknown snapshot.
            ctx.params.onContextAccountingEvent?.({
              kind: "model",
              contextTokens: deriveSessionTotalTokens({
                lastCallUsage: normalizeUsage(message.usage),
              }),
            });
          }
        }
        void scheduleEvent(evt, () => {
          return handleMessageEnd(ctx, evt as never);
        });
        return;
      }
      case "tool_execution_start":
        void scheduleEvent(evt, () => {
          return handleToolExecutionStart(ctx, evt as never);
        });
        return;
      case "tool_execution_update":
        void scheduleEvent(evt, () => {
          handleToolExecutionUpdate(ctx, evt as never);
        });
        return;
      case "tool_execution_end":
        void scheduleEvent(evt, async () => {
          await handleToolExecutionEnd(ctx, evt as never);
        });
        return;
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
      case "compaction_end":
        // The attempt's replacement hook already recorded its private commit fact.
        // Keep public completion timing and standalone subscriber counting unchanged.
        void scheduleEvent(evt, () => {
          handleCompactionEnd(ctx, evt);
        });
        return;
      case "agent_end":
        return scheduleEvent(evt, () => {
          return handleAgentEnd(ctx, evt as never);
        });
      default:
    }
  };
}
