import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerSessionDiscussionProvider } from "openclaw/plugin-sdk/session-discussion";
import { createSessionVisibilityChecker } from "openclaw/plugin-sdk/session-visibility";
import { ClickClackDiscussionService } from "./service.js";
import {
  enforceClickClackDiscussionToolTarget,
  isClickClackDiscussionSessionTarget,
} from "./tool-policy.js";
import { createClickClackDiscussionTool } from "./tool.js";

export function registerClickClackDiscussions(api: OpenClawPluginApi): void {
  if (api.registrationMode === "tool-discovery") {
    api.registerTool(() => null, { name: "discussion" });
    return;
  }

  const service = new ClickClackDiscussionService(api.runtime);
  api.registerTool((context) =>
    createClickClackDiscussionTool({ service, sessionKey: context.sessionKey }),
  );
  api.on("before_tool_call", (event, context) =>
    enforceClickClackDiscussionToolTarget({ runtime: api.runtime, event, context }),
  );
  const unregisterSessionAccess = createSessionVisibilityChecker.registerScopedAccessProvider(
    ({ requesterSessionKey, targetSessionKey }) => {
      const target = isClickClackDiscussionSessionTarget({
        runtime: api.runtime,
        requesterSessionKey,
        targetSessionKey,
      });
      return target ? { expectedSessionId: target.binding.sessionId } : undefined;
    },
  );
  // Registration is process-stable; provider methods read live config so a
  // channel hot reload can enable discussions without restarting the gateway.
  registerSessionDiscussionProvider(service.provider);
  api.lifecycle.registerRuntimeLifecycle({
    id: "clickclack-discussions",
    description: "Stops the lifecycle reconciler for managed ClickClack discussions.",
    cleanup: () => {
      unregisterSessionAccess();
      service.cleanup();
    },
  });
}
