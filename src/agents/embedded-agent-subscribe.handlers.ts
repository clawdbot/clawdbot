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

export function createEmbeddedAgentSessionEventHandler(ctx: EmbeddedAgentSubscribeContext) {
  let pendingEventChain: Promise<void> | null = null;

  const scheduleEvent = (
    evt: EmbeddedAgentSubscribeEvent,
    handler: () => void | Promise<void>,
    options?: { detach?: boolean },
  ): void => {
    const run = () => {
      try {
        return handler();
      } catch (err) {
        ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
      }
    };

    if (!pendingEventChain) {
      const result = run();
      if (!isPromiseLike<void>(result)) {
        return;
      }
      const task = result
        .catch((err: unknown) => {
          ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
        })
        .finally(() => {
          if (pendingEventChain === task) {
            pendingEventChain = null;
          }
        });
      if (!options?.detach) {
        pendingEventChain = task;
      }
      return;
    }

    const task = pendingEventChain
      .then(() => run())
      .catch((err: unknown) => {
        ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
      })
      .finally(() => {
        if (pendingEventChain === task) {
          pendingEventChain = null;
        }
      });
    if (!options?.detach) {
      pendingEventChain = task;
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
          return handleAgentEnd(ctx);
        });
      default:
    }
  };
}
