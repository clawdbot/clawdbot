import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";

const pluginId = "qa-plugin-hook-contracts";
const recordedEventsKey = Symbol.for("openclaw.qa.plugin-hook-contracts.events");
const registeredHookNames = [
  "before_tool_call",
  "message_received",
  "message_sending",
  "session_start",
  "session_end",
  "cron_changed",
] as const;

type RecordedHookEvent = {
  context: Record<string, unknown>;
  event: Record<string, unknown>;
  hookName: (typeof registeredHookNames)[number];
};

function recordedEvents(): RecordedHookEvent[] {
  return ((globalThis as Record<PropertyKey, unknown>)[recordedEventsKey] ??
    []) as RecordedHookEvent[];
}

function requireGlobalHookRunner() {
  const runner = getGlobalHookRunner();
  if (!runner) {
    throw new Error("expected the fixture plugin to initialize the global hook runner");
  }
  return runner;
}

function loadFixturePlugin() {
  (globalThis as Record<PropertyKey, unknown>)[recordedEventsKey] = [];
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: pluginId,
    body: `
const eventsKey = Symbol.for("openclaw.qa.plugin-hook-contracts.events");
function record(hookName, event, context) {
  const events = globalThis[eventsKey] ?? (globalThis[eventsKey] = []);
  events.push({ hookName, event, context });
}

module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.on("before_tool_call", (event, context) => {
      record("before_tool_call", event, context);
      if (event.toolName !== "exec") {
        return;
      }
      return {
        params: { ...event.params, policyChecked: true },
        requireApproval: {
          title: "Approve QA exec",
          description: "The fixture plugin requires operator approval.",
          severity: "info",
        },
      };
    });
    api.on("message_received", (event, context) => {
      record("message_received", event, context);
    });
    api.on("message_sending", (event, context) => {
      record("message_sending", event, context);
      return { content: event.content + " [plugin checked]" };
    });
    api.on("session_start", (event, context) => {
      record("session_start", event, context);
    });
    api.on("session_end", (event, context) => {
      record("session_end", event, context);
    });
    api.on("cron_changed", (event, context) => {
      record("cron_changed", event, context);
    });
  },
};
`,
  });
  const registry = loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        entries: {
          [plugin.id]: {
            enabled: true,
            hooks: { allowConversationAccess: true },
          },
        },
      },
    },
    workspaceDir: plugin.dir,
  });
  initializeGlobalHookRunner(registry);
  return registry;
}

afterEach(() => {
  setEmbeddedPluginApprovalBroker(null);
  setEmbeddedMode(false);
  resetGlobalHookRunner();
  resetPluginLoaderTestStateForTest();
  delete (globalThis as Record<PropertyKey, unknown>)[recordedEventsKey];
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("plugin hook lifecycle contracts", () => {
  it("registers the six typed hook boundaries through the production plugin loader", () => {
    const registry = loadFixturePlugin();

    expect(registry.plugins).toEqual([expect.objectContaining({ id: pluginId, status: "loaded" })]);
    expect(
      registry.typedHooks
        .filter((registration) => registration.pluginId === pluginId)
        .map((registration) => registration.hookName),
    ).toEqual(registeredHookNames);
  });

  it("executes message, session, and cron lifecycle hooks from the loaded plugin", async () => {
    loadFixturePlugin();
    const runner = requireGlobalHookRunner();
    const messageContext = { channelId: "qa-channel" };

    await runner.runMessageReceived({ from: "operator", content: "incoming" }, messageContext);
    await expect(
      runner.runMessageSending({ to: "operator", content: "outgoing" }, messageContext),
    ).resolves.toEqual({ content: "outgoing [plugin checked]" });

    const sessionContext = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    };
    await runner.runSessionStart(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        resumedFrom: "session-0",
      },
      sessionContext,
    );
    await runner.runSessionEnd(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        messageCount: 3,
        reason: "reset",
      },
      sessionContext,
    );

    await runner.runCronChanged(
      {
        action: "updated",
        jobId: "job-1",
        agentId: "main",
        sessionTarget: "main",
        nextRunAtMs: 123,
        job: {
          id: "job-1",
          agentId: "main",
          sessionTarget: "main",
          state: { nextRunAtMs: 123 },
        },
      },
      {
        port: 18789,
        config: {},
        workspaceDir: "/tmp/openclaw-qa-workspace",
        getCron: () => undefined,
      },
    );

    expect(recordedEvents().map((entry) => entry.hookName)).toEqual([
      "message_received",
      "message_sending",
      "session_start",
      "session_end",
      "cron_changed",
    ]);
    expect(recordedEvents()[1]?.event).toMatchObject({
      content: "outgoing",
      to: "operator",
    });
    expect(recordedEvents()[4]?.event).toMatchObject({
      action: "updated",
      jobId: "job-1",
      nextRunAtMs: 123,
    });
  });

  it("routes a loaded before_tool_call policy through the embedded approval boundary", async () => {
    loadFixturePlugin();
    setEmbeddedMode(true);
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedPluginApprovalBroker(broker);

    const resultPromise = runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "pwd" },
      toolCallId: "call-1",
      ctx: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      },
    });

    await vi.waitFor(() => {
      expect(broker.listPending()).toHaveLength(1);
    });
    const pending = broker.listPending()[0];
    if (!pending) {
      throw new Error("expected a pending plugin approval request");
    }
    expect(pending.request).toMatchObject({
      pluginId,
      title: "Approve QA exec",
      toolCallId: "call-1",
      toolName: "exec",
    });
    expect(broker.resolve(pending.id, "allow-once")).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      approvalResolution: "allow-once",
      blocked: false,
      params: { command: "pwd", policyChecked: true },
    });
    expect(recordedEvents()).toEqual([
      expect.objectContaining({
        hookName: "before_tool_call",
        event: expect.objectContaining({
          params: { command: "pwd" },
          toolCallId: "call-1",
          toolName: "exec",
        }),
        context: expect.objectContaining({
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
      }),
    ]);
  });
});
