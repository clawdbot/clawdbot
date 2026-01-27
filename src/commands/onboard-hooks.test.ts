import { describe, expect, it, vi, beforeEach } from "vitest";
import { setupInternalHooks } from "./onboard-hooks.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { HookStatusReport } from "../hooks/hooks-status.js";

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

  const createMockHookReport = (eligible = true): HookStatusReport => ({
    workspaceDir: "/mock/workspace",
    managedHooksDir: "/mock/.clawdbot/hooks",
    hooks: [
      {
        name: "session-memory",
        description: "Save session context to memory when /new command is issued",
        source: "clawdbot-bundled",
        pluginId: undefined,
        filePath: "/mock/workspace/hooks/session-memory/HOOK.md",
        baseDir: "/mock/workspace/hooks/session-memory",
        handlerPath: "/mock/workspace/hooks/session-memory/handler.js",
        hookKey: "session-memory",
        emoji: "💾",
        events: ["command:new"],
        homepage: undefined,
        always: false,
        disabled: false,
        eligible,
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
      },
      {
        name: "command-logger",
        description: "Log all command events to a centralized audit file",
        source: "clawdbot-bundled",
        pluginId: undefined,
        filePath: "/mock/workspace/hooks/command-logger/HOOK.md",
        baseDir: "/mock/workspace/hooks/command-logger",
        handlerPath: "/mock/workspace/hooks/command-logger/handler.js",
        hookKey: "command-logger",
        emoji: "📝",
        events: ["command"],
        homepage: undefined,
        always: false,
        disabled: false,
        eligible,
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
      },
    ],
  });

  describe("setupInternalHooks", () => {
    it("should enable hooks when user selects them", async () => {
      const { buildWorkspaceHookStatus } = await import("../hooks/hooks-status.js");
      vi.mocked(buildWorkspaceHookStatus).mockReturnValue(createMockHookReport());

      const cfg: ClawdbotConfig = {};
      const prompter = createMockPrompter(["session-memory"]);
      const runtime = createMockRuntime();

      const result = await setupInternalHooks(cfg, runtime, prompter);

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
            hint: "Save session context to memory when /new command is issued",
          },
          {
            value: "command-logger",
            label: "📝 command-logger",
            hint: "Log all command events to a centralized audit file",
          },
        ],
      });
    });

    it("should not enable hooks when user skips", async () => {
      const { buildWorkspaceHookStatus } = await import("../hooks/hooks-status.js");
      vi.mocked(buildWorkspaceHookStatus).mockReturnValue(createMockHookReport());

      const cfg: ClawdbotConfig = {};
      const prompter = createMockPrompter(["__skip__"]);
      const runtime = createMockRuntime();

      const result = await setupInternalHooks(cfg, runtime, prompter);

      expect(result.hooks?.internal).toBeUndefined();
      expect(prompter.note).toHaveBeenCalledTimes(1);
    });

    it("should handle no eligible hooks", async () => {
      const { buildWorkspaceHookStatus } = await import("../hooks/hooks-status.js");
      vi.mocked(buildWorkspaceHookStatus).mockReturnValue(createMockHookReport(false));

      const cfg: ClawdbotConfig = {};
      const prompter = createMockPrompter([]);
      const runtime = createMockRuntime();

      const result = await setupInternalHooks(cfg, runtime, prompter);

      expect(result).toEqual(cfg);
      expect(prompter.multiselect).not.toHaveBeenCalled();
      expect(prompter.note).toHaveBeenCalledWith(
        "No eligible hooks found. You can configure hooks later in your config.",
        "No Hooks Available",
      );
    });

    it("should preserve existing hooks config when enabled", async () => {
      const { buildWorkspaceHookStatus } = await import("../hooks/hooks-status.js");
      vi.mocked(buildWorkspaceHookStatus).mockReturnValue(createMockHookReport());

      const cfg: ClawdbotConfig = {
        hooks: {
          enabled: true,
          path: "/webhook",
          token: "existing-token",
        },
      };
      const prompter = createMockPrompter(["session-memory"]);
      const runtime = createMockRuntime();

      const result = await setupInternalHooks(cfg, runtime, prompter);

      expect(result.hooks?.enabled).toBe(true);
      expect(result.hooks?.path).toBe("/webhook");
      expect(result.hooks?.token).toBe("existing-token");
      expect(result.hooks?.internal?.enabled).toBe(true);
      expect(result.hooks?.internal?.entries).toEqual({
        "session-memory": { enabled: true },
      });
    });

    it("should preserve existing config when user skips", async () => {
      const { buildWorkspaceHookStatus } = await import("../hooks/hooks-status.js");
      vi.mocked(buildWorkspaceHookStatus).mockReturnValue(createMockHookReport());

      const cfg: ClawdbotConfig = {
        agents: { defaults: { workspace: "/workspace" } },
      };
      const prompter = createMockPrompter(["__skip__"]);
      const runtime = createMockRuntime();

      const result = await setupInternalHooks(cfg, runtime, prompter);

      expect(result).toEqual(cfg);
      expect(result.agents?.defaults?.workspace).toBe("/workspace");
    });

    it("should show informative notes to user", async () => {
      const { buildWorkspaceHookStatus } = await import("../hooks/hooks-status.js");
      vi.mocked(buildWorkspaceHookStatus).mockReturnValue(createMockHookReport());

      const cfg: ClawdbotConfig = {};
      const prompter = createMockPrompter(["session-memory"]);
      const runtime = createMockRuntime();

      await setupInternalHooks(cfg, runtime, prompter);

      const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      expect(noteCalls).toHaveLength(2);

      // First note should explain what hooks are
      expect(noteCalls[0][0]).toContain("Hooks let you automate actions");
      expect(noteCalls[0][0]).toContain("automate actions");

      // Second note should confirm configuration
      expect(noteCalls[1][0]).toContain("Enabled 1 hook: session-memory");
      expect(noteCalls[1][0]).toMatch(/clawdbot( --profile isolated)? hooks list/);
    });
  });
});
