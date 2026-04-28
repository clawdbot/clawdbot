import type { OpenClawPluginApi } from "../types.js";

export function registerHostHookFixture(api: OpenClawPluginApi) {
  api.registerSessionExtension({
    namespace: "workflow",
    description: "Generic approval-workflow state projection",
  });
  api.registerToolMetadata({
    toolName: "approval_fixture_tool",
    displayName: "Approval Fixture Tool",
    description: "Fixture metadata for a plugin-owned tool",
    risk: "medium",
    tags: ["fixture", "approval"],
  });
  api.registerControlUiDescriptor({
    id: "workflow-card",
    surface: "session",
    label: "Workflow Card",
    description: "Generic Control UI descriptor for workflow state",
    placement: "session-sidebar",
  });
  api.registerRuntimeLifecycle({
    id: "workflow-cleanup",
    description: "Generic cleanup hook for plugin-owned workflow state",
  });
  api.registerAgentEventSubscription({
    id: "workflow-events",
    description: "Generic sanitized agent-event subscription for workflow plugins",
    streams: ["lifecycle", "tool"],
    handle(event, ctx) {
      if (event.stream === "tool") {
        ctx.setRunContext("lastToolEvent", {
          runId: event.runId,
          seen: true,
        });
      }
    },
  });
  api.registerSessionSchedulerJob({
    id: "workflow-nudge",
    sessionKey: "agent:main:main",
    kind: "nudge",
    description: "Generic session-owned scheduler cleanup fixture",
  });
  api.registerCommand({
    name: "host-hook-fixture",
    description: "Exercise host-hook command continuation",
    acceptsArgs: true,
    handler: async (ctx) => ({
      text: `fixture:${ctx.args ?? "empty"}`,
      continueAgent: true,
    }),
  });
  api.on("agent_turn_prepare", () => ({
    prependContext: "fixture turn context",
  }));
  api.on("heartbeat_prompt_contribution", () => ({
    appendContext: "fixture heartbeat context",
  }));
}

export function registerTrustedHostHookFixture(api: OpenClawPluginApi) {
  registerHostHookFixture(api);
  api.registerTrustedToolPolicy({
    id: "budget-policy",
    description: "Generic budget/workspace policy gate fixture",
    evaluate(event) {
      if (event.toolName === "blocked_fixture_tool") {
        return { block: true, blockReason: "blocked by fixture policy" };
      }
      return undefined;
    },
  });
}
