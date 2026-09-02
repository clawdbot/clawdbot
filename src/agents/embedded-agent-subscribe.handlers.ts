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
  handleMessageStart,
  handleMessageEnd,
} from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import { handleMessageUpdate } from "./embedded-agent-subscribe.handlers.messages.update.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./embedded-agent-subscribe.handlers.tools.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentSessionEvent } from "./sessions/index.js";

/** Create the serialized event dispatcher for subscribed embedded-agent sessions. */
export function createEmbeddedAgentSessionEventHandler(ctx: EmbeddedAgentSubscribeContext) {
  const scheduleEvent = (evt: AgentSessionEvent, handler: () => unknown): void | Promise<void> => {
    // Tool-result delivery must settle before later assistant or terminal events;
    // suppression flags would discard those events instead of preserving order.
    const run = () => {
      try {
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

  return (evt: AgentSessionEvent) => {
    // Model facts advance before persistence, independently of queued reply delivery.
    ctx.captureModelEvent(evt);
    switch (evt.type) {
      case "message_start":
        void scheduleEvent(evt, () => handleMessageStart(ctx, evt));
        return;
      case "message_update":
        void scheduleEvent(evt, () => handleMessageUpdate(ctx, evt));
        return;
      case "message_end":
        void scheduleEvent(evt, () => handleMessageEnd(ctx, evt));
        return;
      case "tool_execution_start":
        void scheduleEvent(evt, () => handleToolExecutionStart(ctx, evt));
        return;
      case "tool_execution_update":
        void scheduleEvent(evt, () => handleToolExecutionUpdate(ctx, evt));
        return;
      case "tool_execution_end":
        void scheduleEvent(evt, () => handleToolExecutionEnd(ctx, evt));
        return;
      case "agent_start":
        void scheduleEvent(evt, () => handleAgentStart(ctx));
        return;
      case "compaction_start":
        void scheduleEvent(evt, () => handleCompactionStart(ctx, evt));
        return;
      case "compaction_end":
        // The attempt's replacement hook already recorded its private commit fact.
        // Keep public completion timing and standalone subscriber counting unchanged.
        void scheduleEvent(evt, () => handleCompactionEnd(ctx, evt));
        return;
      case "agent_end":
        return scheduleEvent(evt, () => handleAgentEnd(ctx, evt));
      default:
    }
  };
}
