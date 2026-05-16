import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { setupInternalHooks } from "./onboard-hooks.js";

// Mock hook discovery modules
vi.mock("../hooks/hooks-status.js", () => ({
  buildWorkspaceHookStatus: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/mock/workspace"),
  resolveDefaultAgentId: vi.fn().mockReturnValue("main"),
}));

describe("onboard-hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_LOCALE;
  });

  const createMockPrompter = (multiselectValue: string[]): WizardPrompter => ({
    confirm: vi.fn().mockResolvedValue(true),
    note: vi.fn().mockResolvedValue(undefined),
    intro: vi.fn().mockResolvedValue(undefined),
    outro: vi.fn().mockResolvedValue(undefined),
    text: vi.fn().mockResolvedValue(""),
    select: vi.fn().mockResolvedValue(""),
    multiselect: vi.fn().mockResolvedValue(multiselectValue),
    progress: vi.fn().mockReturnValue({
      stop: vi.fn(),
      update: vi.fn(),
    }),
  });

  const createMockRuntime = (): RuntimeEnv => ({
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  });

  const createMockHook = (
    params: {
      name: string;
      description: string;
      filePath: string;
      baseDir: string;
      handlerPath: string;
      hookKey: string;
      emoji: string;
      events: string[];
    },
    eligible: boolean,
  ) => ({
    blockedReason: (eligible
      ? undefined
      : "missing requirements") as HookStatusEntry["blockedReason"],
    ...params,
    source: "openclaw-bundled" as const,
    pluginId: undefined,
    homepage: undefined,
    always: false,
    enabledByConfig: eligible,
    requirementsSatisfied: eligible,
    loadable: eligible,
    managedByPlugin: false,
    requirements: {
      bins: [],
      anyBins: [],
      env: [],
      config: ["workspace.dir"],
      os: [],
    },
    missing: {
      bins: [],
      anyBins: [],
      env: [],
      config: eligible ? [] : ["workspace.dir"],
      os: [],
    },
    configChecks: [],
    install: [],
  });

  const createMockHookReport = (eligible = true): HookStatusReport => ({
    workspaceDir: "/mock/workspace",
    managedHooksDir: "/mock/.openclaw/hooks",
    hooks: [
      createMockHook(
        {
          name: "session-memory",
          description: "Save session context to memory when /new or /reset command is issued",
          filePath: "/mock/workspace/hooks/session-memory/HOOK.md",
          baseDir: "/mock/workspace/hooks/session-memory",
          handlerPath: "/mock/workspace/hooks/session-memory/handler.js",
          hookKey: "session-memory",
          emoji: "💾",
          events: ["command:new", "command:reset"],
        },
        eligible,
      ),
      createMockHook(
        {
          name: "command-logger",
          description: "Log all command events to a centralized audit file",
          filePath: "/mock/workspace/hooks/command-logger/HOOK.md",
          baseDir: "/mock/workspace/hooks/command-logger",
          handlerPath: "/mock/workspace/hooks/command-logger/handler.js",
          hookKey: "command-logger",
          emoji: "📝",
          events: ["command"],
        },
        eligible,
      ),
    ],
  });

  async function runSetupInternalHooks(params: {
    selected: string[];
    cfg?: OpenClawConfig;
    eligible?: boolean;
  }) {
    const { buildWorkspaceHookStatus } = await import("../hooks/hooks-status.js");
    vi.mocked(buildWorkspaceHookStatus).mockReturnValue(
      createMockHookReport(params.eligible ?? true),
    );

    const cfg = params.cfg ?? {};
    const prompter = createMockPrompter(params.selected);
    const runtime = createMockRuntime();
    const result = await setupInternalHooks(cfg, runtime, prompter);
    return { result, cfg, prompter };
  }

  describe("setupInternalHooks", () => {
    beforeEach(() => {
      vi.unstubAllEnvs();
    });

    it("should enable hooks when user selects them", async () => {
      const { result, prompter } = await runSetupInternalHooks({
        selected: ["session-memory"],
      });

      expect(result.hooks?.internal?.enabled).toBe(true);
      expect(result.hooks?.internal?.entries).toEqual({
        "session-memory": { enabled: true },
      });
      expect(prompter.note).toHaveBeenCalledTimes(2);
      expect(prompter.multiselect).toHaveBeenCalledWith({
        message: "Enable hooks?",
        options: [
          { value: "__skip__", label: "Skip for now" },
          {
            value: "session-memory",
            label: "💾 session-memory",
            hint: "Save session context to memory when /new or /reset command is issued",
          },
          {
            value: "command-logger",
            label: "📝 command-logger",
            hint: "Log all command events to a centralized audit file",
          },
        ],
      });
    });

    it("localizes built-in hook prompts when OPENCLAW_LOCALE is set", async () => {
      process.env.OPENCLAW_LOCALE = "zh-CN";
      const { prompter } = await runSetupInternalHooks({
        selected: ["__skip__"],
      });

      expect(prompter.multiselect).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "启用 hooks？",
          options: expect.arrayContaining([{ value: "__skip__", label: "暂时跳过" }]),
        }),
      );
    });

    it("should not enable hooks when user skips", async () => {
      const { result, prompter } = await runSetupInternalHooks({
        selected: ["__skip__"],
      });

      expect(result.hooks?.internal).toBeUndefined();
      expect(prompter.note).toHaveBeenCalledTimes(1);
    });

    it("should handle no eligible hooks", async () => {
      const { result, cfg, prompter } = await runSetupInternalHooks({
        selected: [],
        eligible: false,
      });

      expect(result).toEqual(cfg);
      expect(prompter.multiselect).not.toHaveBeenCalled();
      expect(prompter.note).toHaveBeenCalledWith(
        "No eligible hooks found. You can configure hooks later in your config.",
        "No Hooks Available",
      );
    });

    it("should preserve existing hooks config when enabled", async () => {
      const cfg: OpenClawConfig = {
        hooks: {
          enabled: true,
          path: "/webhook",
          token: "existing-token",
        },
      };
      const { result } = await runSetupInternalHooks({
        selected: ["session-memory"],
        cfg,
      });

      expect(result.hooks?.enabled).toBe(true);
      expect(result.hooks?.path).toBe("/webhook");
      expect(result.hooks?.token).toBe("existing-token");
      expect(result.hooks?.internal?.enabled).toBe(true);
      expect(result.hooks?.internal?.entries).toEqual({
        "session-memory": { enabled: true },
      });
    });

    it("should preserve existing config when user skips", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: "/workspace" } },
      };
      const { result } = await runSetupInternalHooks({
        selected: ["__skip__"],
        cfg,
      });

      expect(result).toEqual(cfg);
      expect(result.agents?.defaults?.workspace).toBe("/workspace");
    });

    it("should show informative notes to user", async () => {
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
      vi.stubEnv("OPENCLAW_PROFILE", "");
      const { prompter } = await runSetupInternalHooks({
        selected: ["session-memory"],
      });

      const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      expect(noteCalls).toEqual([
        [
          [
            "Hooks let you automate actions when agent commands are issued.",
            "Example: Save session context to memory when you issue /new or /reset.",
            "",
            "Learn more: https://docs.openclaw.ai/automation/hooks",
          ].join("\n"),
          "Hooks",
        ],
        [
          [
            "Enabled 1 hook: session-memory",
            "",
            "You can manage hooks later with:",
            "  openclaw hooks list",
            "  openclaw hooks enable <name>",
            "  openclaw hooks disable <name>",
          ].join("\n"),
          "Hooks Configured",
        ],
      ]);
    });
  });
});
