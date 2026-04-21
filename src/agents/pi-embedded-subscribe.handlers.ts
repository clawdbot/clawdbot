import {
  handleAgentEnd,
  handleAgentStart,
  handleCompactionEnd,
  handleCompactionStart,
} from "./pi-embedded-subscribe.handlers.lifecycle.js";
import {
  handleMessageEnd,
  handleMessageStart,
  handleMessageUpdate,
} from "./pi-embedded-subscribe.handlers.messages.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type {
  EmbeddedPiSubscribeContext,
  EmbeddedPiSubscribeEvent,
} from "./pi-embedded-subscribe.handlers.types.js";
import { isPromiseLike } from "./pi-embedded-subscribe.promise.js";

export function createEmbeddedPiSessionEventHandler(ctx: EmbeddedPiSubscribeContext) {
  let pendingEventChain: Promise<void> | null = null;

  const scheduleEvent = (
    evt: EmbeddedPiSubscribeEvent,
    handler: () => void | Promise<void>,
    options?: { detach?: boolean },
  ): void => {
    const run = () => {
      try {
        return handler();
      } catch (err) {
        ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
        return;
      }
    };

    if (!pendingEventChain) {
      const result = run();
      if (!isPromiseLike<void>(result)) {
        return;
      }
      const task = result
        .catch((err) => {
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
      .catch((err) => {
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

  return (evt: EmbeddedPiSubscribeEvent) => {
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
          handleCompactionStart(ctx);
        });
        return;
      case "compaction_end":
        scheduleEvent(evt, () => {
          handleCompactionEnd(ctx, evt as never);
        });
        return;
      case "agent_end":
        scheduleEvent(evt, () => {
          return handleAgentEnd(ctx);
        });
        return;
      default:
        return;
    }
  };
}
