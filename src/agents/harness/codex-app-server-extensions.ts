import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { listCodexAppServerExtensionFactories } from "../../plugins/codex-app-server-extension-factory.js";
import type {
  CodexAppServerExtensionContext,
  CodexAppServerExtensionFactory,
  CodexAppServerExtensionRuntime,
  CodexAppServerToolResultEvent,
} from "../../plugins/codex-app-server-extension-types.js";

const log = createSubsystemLogger("agents/harness");

type CodexToolResultHandler = Parameters<CodexAppServerExtensionRuntime["on"]>[1];

export function createCodexAppServerToolResultExtensionRunner(
  ctx: CodexAppServerExtensionContext,
  factories: CodexAppServerExtensionFactory[] = listCodexAppServerExtensionFactories(),
) {
  const handlers: CodexToolResultHandler[] = [];
  const runtime: CodexAppServerExtensionRuntime = {
    on(event, handler) {
      if (event === "tool_result") {
        handlers.push(handler);
      }
    },
  };
  const initPromise = (async () => {
    for (const factory of factories) {
      await factory(runtime);
    }
  })();

  return {
    async applyToolResultExtensions(
      event: CodexAppServerToolResultEvent,
    ): Promise<AgentToolResult<unknown>> {
      await initPromise;
      let current = event.result;
      for (const handler of handlers) {
        try {
          const next = await handler({ ...event, result: current }, ctx);
          if (next?.result) {
            current = next.result;
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log.warn(`[codex] tool_result extension failed for ${event.toolName}: ${detail}`);
        }
      }
      return current;
    },
  };
}
