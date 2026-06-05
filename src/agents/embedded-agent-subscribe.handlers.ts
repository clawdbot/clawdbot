/**
 * Dispatches serialized embedded-agent subscription events to specific handlers.
 */
import {
  handleAgentEnd,
  handleAgentStart,
  handleCompactionEnd,
  handleCompactionStart,
} from "./embedded-agent-subscribe.handlers.lifecycle.js";
import {
  handleMessageEnd,
  handleMessageStart,
  handleMessageUpdate,
} from "./embedded-agent-subscribe.handlers.messages.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./embedded-agent-subscribe.handlers.tools.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeEvent,
} from "./embedded-agent-subscribe.handlers.types.js";
import { isPromiseLike } from "./embedded-agent-subscribe.promise.js";

/** Create the serialized event dispatcher for subscribed embedded-agent sessions. */
export function createEmbeddedAgentSessionEventHandler(ctx: EmbeddedAgentSubscribeContext) {
  const scheduleEvent = (
    evt: EmbeddedAgentSubscribeEvent,
    handler: () => void | Promise<void>,
    options?: { detach?: boolean },
  ): void => {
    // Most stream events must preserve order across async formatting and flush
    // work. A detached event may run after the chain without blocking delivery.
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
      if (!options?.detach) {
        ctx.state.pendingEventChain = task;
      }
      return;
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
    if (!options?.detach) {
      ctx.state.pendingEventChain = task;
    }
  };

  return (evt: EmbeddedAgentSubscribeEvent) => {
    switch (evt.type) {
      case "message_start":
        scheduleEvent(evt, () => {
          handleMessageStart(ctx, evt as never);
        });
        return;
      case "message_update":
        scheduleEvent(evt, () => {
          handleMessageUpdate(ctx, evt as never);
        });
        return;
      case "message_end":
        scheduleEvent(evt, () => {
          return handleMessageEnd(ctx, evt as never);
        });
        return;
      case "tool_execution_start":
        scheduleEvent(evt, () => {
          return handleToolExecutionStart(ctx, evt as never);
        });
        return;
      case "tool_execution_update":
        scheduleEvent(evt, () => {
          handleToolExecutionUpdate(ctx, evt as never);
        });
        return;
      case "tool_execution_end":
        scheduleEvent(
          evt,
          () => {
            return handleToolExecutionEnd(ctx, evt as never);
          },
          { detach: true },
        );
        return;
      case "agent_start":
        scheduleEvent(evt, () => {
          handleAgentStart(ctx);
        });
        return;
      case "compaction_start":
        scheduleEvent(evt, () => {
          handleCompactionStart(ctx, {
            type: "compaction_start",
            reason: evt.reason,
          });
        });
        return;
      case "compaction_end":
        scheduleEvent(evt, () => {
          handleCompactionEnd(ctx, {
            type: "compaction_end",
            reason: evt.reason,
            willRetry: evt.willRetry,
            result: evt.result,
            aborted: evt.aborted,
          });
        });
        return;
      case "agent_end":
        scheduleEvent(evt, () => {
          return handleAgentEnd(ctx, evt as never);
        });
      default:
    }
  };
}
