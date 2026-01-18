import { describe, expect, it } from "vitest";
import type { HookStatusReport } from "../hooks/hooks-status.js";
import { formatHooksCheck, formatHooksList } from "./hooks-cli.js";

const report: HookStatusReport = {
  workspaceDir: "/tmp/workspace",
  managedHooksDir: "/tmp/hooks",
  hooks: [
    {
      name: "session-memory",
      description: "Save session context to memory",
      source: "clawdbot-bundled",
      pluginId: undefined,
      filePath: "/tmp/hooks/session-memory/HOOK.md",
      baseDir: "/tmp/hooks/session-memory",
      handlerPath: "/tmp/hooks/session-memory/handler.js",
      hookKey: "session-memory",
      emoji: "💾",
      homepage: "https://docs.clawd.bot/hooks#session-memory",
      events: ["command:new"],
      always: false,
      disabled: false,
      eligible: true,
      managedByPlugin: false,
      requirements: {
        bins: [],
        anyBins: [],
        env: [],
        config: [],
        os: [],
      },
      missing: {
        bins: [],
        anyBins: [],
        env: [],
        config: [],
        os: [],
      },
      configChecks: [],
      install: [],
    },
  ],
};

describe("hooks cli formatting", () => {
  it("labels hooks list output", () => {
    const output = formatHooksList(report, {});
    expect(output).toContain("Hooks");
    expect(output).not.toContain("Internal Hooks");
  });

  it("labels hooks status output", () => {
    const output = formatHooksCheck(report, {});
    expect(output).toContain("Hooks Status");
  });

  it("labels plugin-managed hooks with plugin id", () => {
    const pluginReport: HookStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedHooksDir: "/tmp/hooks",
      hooks: [
        {
          name: "plugin-hook",
          description: "Hook from plugin",
          source: "clawdbot-plugin",
          pluginId: "voice-call",
          filePath: "/tmp/hooks/plugin-hook/HOOK.md",
          baseDir: "/tmp/hooks/plugin-hook",
          handlerPath: "/tmp/hooks/plugin-hook/handler.js",
          hookKey: "plugin-hook",
          emoji: "🔗",
          homepage: undefined,
          events: ["command:new"],
          always: false,
          disabled: false,
          eligible: true,
          managedByPlugin: true,
          requirements: {
            bins: [],
            anyBins: [],
            env: [],
            config: [],
            os: [],
          },
          missing: {
            bins: [],
            anyBins: [],
            env: [],
            config: [],
            os: [],
          },
          configChecks: [],
          install: [],
        },
      ],
    };

    const output = formatHooksList(pluginReport, {});
    expect(output).toContain("plugin:voice-call");
  });
});
