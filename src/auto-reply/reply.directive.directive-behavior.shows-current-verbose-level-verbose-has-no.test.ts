import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { installDirectiveBehaviorE2EHooks } from "./reply.directive.directive-behavior.e2e-harness.js";
import { runEmbeddedPiAgentMock } from "./reply.directive.directive-behavior.e2e-mocks.js";
import { handleDirectiveOnly } from "./reply/directive-handling.impl.js";
import type { HandleDirectiveOnlyParams } from "./reply/directive-handling.params.js";
import { parseInlineDirectives } from "./reply/directive-handling.parse.js";

const emptyAliasIndex: ModelAliasIndex = {
  byAlias: new Map(),
  byKey: new Map(),
};

async function runDirectiveStatus(
  body: string,
  overrides: Partial<HandleDirectiveOnlyParams> = {},
): Promise<{ text?: string; sessionEntry: SessionEntry }> {
  const sessionKey = "agent:main:whatsapp:+1222";
  const sessionEntry: SessionEntry = {
    sessionId: "status",
    updatedAt: Date.now(),
  };
  const cfg = {
    commands: { text: true },
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        workspace: "/tmp/openclaw",
      },
    },
  } as OpenClawConfig;
  const effectiveSessionKey = overrides.sessionKey ?? sessionKey;
  const effectiveSessionEntry = overrides.sessionEntry ?? sessionEntry;
  const effectiveSessionStore = overrides.sessionStore ?? {
    [effectiveSessionKey]: effectiveSessionEntry,
  };
  const {
    sessionKey: _ignoredSessionKey,
    sessionEntry: _ignoredSessionEntry,
    sessionStore: _ignoredSessionStore,
    ...restOverrides
  } = overrides;
  const result = await handleDirectiveOnly({
    cfg,
    directives: parseInlineDirectives(body),
    sessionEntry: effectiveSessionEntry,
    sessionStore: effectiveSessionStore,
    sessionKey: effectiveSessionKey,
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: emptyAliasIndex,
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
    ...restOverrides,
  });
  return { text: result?.text, sessionEntry: effectiveSessionEntry };
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("reports current directive defaults when no arguments are provided", async () => {
    const { text: fastText } = await runDirectiveStatus("/fast", {
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            workspace: "/tmp/openclaw",
            models: {
              "anthropic/claude-opus-4-6": {
                params: { fastMode: true },
              },
            },
          },
        },
      } as OpenClawConfig,
    });
    expect(fastText).toContain("Current fast mode: on (config)");
    expect(fastText).toContain("Options: status, on, off.");

    const { text: verboseText } = await runDirectiveStatus("/verbose", {
      currentVerboseLevel: "on",
    });
    expect(verboseText).toContain("Current verbose level: on");
    expect(verboseText).toContain("Options: on, full, off.");

    const { text: reasoningText } = await runDirectiveStatus("/reasoning");
    expect(reasoningText).toContain("Current reasoning level: off");
    expect(reasoningText).toContain("Options: on, off, stream.");

    const { text: elevatedText } = await runDirectiveStatus("/elevated", {
      elevatedAllowed: true,
      elevatedEnabled: true,
      currentElevatedLevel: "on",
    });
    expect(elevatedText).toContain("Current elevated level: on");
    expect(elevatedText).toContain("Options: on, off, ask, full.");

    const { text: execText } = await runDirectiveStatus("/exec", {
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            workspace: "/tmp/openclaw",
          },
        },
        tools: {
          exec: {
            host: "gateway",
            security: "allowlist",
            ask: "always",
            node: "mac-1",
          },
        },
      } as OpenClawConfig,
    });
    expect(execText).toContain(
      "Current exec defaults: host=gateway, effective=gateway, security=allowlist, ask=always, node=mac-1.",
    );
    expect(execText).toContain(
      "Options: host=auto|sandbox|gateway|node, security=deny|allowlist|full, ask=off|on-miss|always, node=<id>.",
    );
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
  it("treats /fast status like the no-argument status query", async () => {
    const { text: statusText } = await runDirectiveStatus("/fast status", {
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            workspace: "/tmp/openclaw",
            models: {
              "anthropic/claude-opus-4-6": {
                params: { fastMode: true },
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(statusText).toContain("Current fast mode: on (config)");
    expect(statusText).toContain("Options: status, on, off.");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
  it("enforces per-agent elevated restrictions and status visibility", async () => {
    const { text: deniedText } = await runDirectiveStatus("/elevated on", {
      sessionKey: "agent:restricted:main",
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [
        {
          gate: "agents.list[].tools.elevated.enabled",
          key: "agents.list.restricted.tools.elevated.enabled",
        },
      ],
    });
    expect(deniedText).toContain("agents.list[].tools.elevated.enabled");

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
  it("applies per-agent allowlist requirements before allowing elevated", async () => {
    const { text: deniedText } = await runDirectiveStatus("/elevated on", {
      sessionKey: "agent:work:main",
      elevatedEnabled: true,
      elevatedAllowed: false,
      elevatedFailures: [
        {
          gate: "agents.list[].tools.elevated.allowFrom.whatsapp",
          key: "agents.list.work.tools.elevated.allowFrom.whatsapp",
        },
      ],
    });
    expect(deniedText).toContain("agents.list[].tools.elevated.allowFrom.whatsapp");

    const { text: allowedText } = await runDirectiveStatus("/elevated on", {
      sessionKey: "agent:work:main",
      elevatedEnabled: true,
      elevatedAllowed: true,
    });
    expect(allowedText).toContain("Elevated mode set to ask");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
  it("handles runtime warning, invalid level, and multi-directive elevated inputs", async () => {
    for (const scenario of [
      {
        body: "/elevated off",
        expectedSnippets: [
          "Elevated mode disabled.",
          "Runtime is direct; sandboxing does not apply.",
        ],
      },
      {
        body: "/elevated maybe",
        expectedSnippets: ["Unrecognized elevated level"],
      },
      {
        body: "/elevated off\n/verbose on",
        expectedSnippets: ["Elevated mode disabled.", "Verbose logging enabled."],
      },
    ]) {
      const { text } = await runDirectiveStatus(scenario.body, {
        elevatedEnabled: true,
        elevatedAllowed: true,
      });
      for (const snippet of scenario.expectedSnippets) {
        expect(text).toContain(snippet);
      }
    }
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
  it("persists queue overrides and reset behavior", async () => {
    const interrupt = await runDirectiveStatus("/queue interrupt");
    expect(interrupt.text).toMatch(/^⚙️ Queue mode set to interrupt\./);
    expect(interrupt.sessionEntry.queueMode).toBe("interrupt");

    const collect = await runDirectiveStatus("/queue collect debounce:2s cap:5 drop:old");

    expect(collect.text).toMatch(/^⚙️ Queue mode set to collect\./);
    expect(collect.text).toMatch(/Queue debounce set to 2000ms/);
    expect(collect.text).toMatch(/Queue cap set to 5/);
    expect(collect.text).toMatch(/Queue drop set to old/);
    expect(collect.sessionEntry.queueMode).toBe("collect");
    expect(collect.sessionEntry.queueDebounceMs).toBe(2000);
    expect(collect.sessionEntry.queueCap).toBe(5);
    expect(collect.sessionEntry.queueDrop).toBe("old");

    const resetEntry: SessionEntry = {
      sessionId: "queue",
      updatedAt: Date.now(),
      queueMode: "collect",
      queueDebounceMs: 2000,
      queueCap: 5,
      queueDrop: "old",
    };
    const reset = await runDirectiveStatus("/queue reset", {
      sessionEntry: resetEntry,
      sessionStore: { "agent:main:whatsapp:+1222": resetEntry },
    });
    expect(reset.text).toMatch(/^⚙️ Queue mode reset to default\./);
    expect(reset.sessionEntry.queueMode).toBeUndefined();
    expect(reset.sessionEntry.queueDebounceMs).toBeUndefined();
    expect(reset.sessionEntry.queueCap).toBeUndefined();
    expect(reset.sessionEntry.queueDrop).toBeUndefined();
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("shows current trace level and persists trace directives", async () => {
    const { text: currentText } = await runDirectiveStatus("/trace", {
      sessionEntry: { sessionId: "trace", updatedAt: Date.now(), traceLevel: "on" },
    });
    expect(currentText).toContain("Current trace level: on");

    const enabled = await runDirectiveStatus("/trace on");
    expect(enabled.text).toContain("Plugin trace enabled.");
    expect(enabled.sessionEntry.traceLevel).toBe("on");

    const disabled = await runDirectiveStatus("/trace off", {
      sessionEntry: { sessionId: "trace", updatedAt: Date.now(), traceLevel: "on" },
    });
    expect(disabled.text).toContain("Plugin trace disabled.");
    expect(disabled.sessionEntry.traceLevel).toBe("off");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
});
