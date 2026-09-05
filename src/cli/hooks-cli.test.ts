// Hooks CLI tests cover hook command registration and output behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookStatusReport } from "../hooks/hooks-status.js";
import { formatHookInfo, formatHooksCheck, formatHooksList } from "./hooks-cli.format.js";
import { registerHooksCli } from "./hooks-cli.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";

const runPluginInstallCommandMock = vi.hoisted(() => vi.fn());
const runPluginUpdateCommandMock = vi.hoisted(() => vi.fn());

vi.mock("./plugins-install-command.js", () => ({
  runPluginInstallCommand: runPluginInstallCommandMock,
}));

vi.mock("./plugins-update-command.js", () => ({
  runPluginUpdateCommand: runPluginUpdateCommandMock,
}));

const report: HookStatusReport = {
  workspaceDir: "/tmp/workspace",
  managedHooksDir: "/tmp/hooks",
  hooks: [
    {
      name: "session-memory",
      description: "Save session context to memory",
      source: "openclaw-bundled",
      pluginId: undefined,
      filePath: "/tmp/hooks/session-memory/HOOK.md",
      baseDir: "/tmp/hooks/session-memory",
      handlerPath: "/tmp/hooks/session-memory/handler.js",
      hookKey: "session-memory",
      emoji: "💾",
      homepage: "https://docs.openclaw.ai/automation/hooks#session-memory",
      events: ["command:new"],
      unknownEvents: [],
      always: false,
      enabledByConfig: true,
      requirementsSatisfied: true,
      loadable: true,
      blockedReason: undefined,
      managedByPlugin: false,
      ...createEmptyInstallChecks(),
    },
  ],
};

beforeEach(() => {
  runPluginInstallCommandMock.mockReset();
  runPluginUpdateCommandMock.mockReset();
});

function createPluginManagedHookReport(): HookStatusReport {
  return {
    workspaceDir: "/tmp/workspace",
    managedHooksDir: "/tmp/hooks",
    hooks: [
      {
        name: "plugin-hook",
        description: "Hook from plugin",
        source: "openclaw-plugin",
        pluginId: "voice-call",
        filePath: "/tmp/hooks/plugin-hook/HOOK.md",
        baseDir: "/tmp/hooks/plugin-hook",
        handlerPath: "/tmp/hooks/plugin-hook/handler.js",
        hookKey: "plugin-hook",
        emoji: "🔗",
        homepage: undefined,
        events: ["command:new"],
        unknownEvents: [],
        always: false,
        enabledByConfig: true,
        requirementsSatisfied: true,
        loadable: true,
        blockedReason: undefined,
        managedByPlugin: true,
        ...createEmptyInstallChecks(),
      },
    ],
  };
}

function createEventlessHookReport(): HookStatusReport {
  return {
    ...report,
    hooks: [
      {
        ...expectDefined(report.hooks[0], "report.hooks[0] test invariant"),
        events: [],
        loadable: false,
        blockedReason: "no events defined",
      },
    ],
  };
}

function createMissingRequirementHookReport(): HookStatusReport {
  return {
    ...report,
    hooks: [
      {
        ...expectDefined(report.hooks[0], "report.hooks[0] test invariant"),
        requirementsSatisfied: false,
        loadable: false,
        blockedReason: "missing requirements",
        requirements: {
          ...expectDefined(report.hooks[0], "report.hooks[0] test invariant").requirements,
          env: ["DEMO_HOOK_TOKEN"],
        },
        missing: {
          ...expectDefined(report.hooks[0], "report.hooks[0] test invariant").missing,
          env: ["DEMO_HOOK_TOKEN"],
        },
      },
    ],
  };
}

describe("hooks cli formatting", () => {
  it("labels hooks list output", () => {
    const output = formatHooksList(report, {});
    expect(output).toContain("Hooks");
    expect(output).not.toContain("Internal Hooks");
  });

  it("shows eventless hooks as blocked by their event declaration in list output", () => {
    const output = formatHooksList(createEventlessHookReport(), {});

    expect(output).toContain("0/1 ready");
    expect(output).toContain("no events defined");
    expect(output).not.toContain("missing requirements");
  });

  it("shows eventless hooks as blocked by their event declaration in verbose list output", () => {
    const output = formatHooksList(createEventlessHookReport(), { verbose: true });

    expect(output).toContain("no events defined");
    expect(output).not.toContain("missing requirements");
  });

  it.each([
    ["disabled in config", "disabled in config"],
    ["workspace hook (disabled by default)", "workspace hook"],
  ] as const)(
    "does not report disabled hook policy as a missing requirement: %s",
    (blockedReason, displayedPolicyReason) => {
      const disabledReport: HookStatusReport = {
        ...report,
        hooks: [
          {
            ...expectDefined(report.hooks[0], "report.hooks[0] test invariant"),
            enabledByConfig: false,
            loadable: false,
            blockedReason,
          },
        ],
      };
      const output = formatHooksList(disabledReport, { verbose: true });

      expect(output).toContain("disabled");
      expect(output).not.toContain(displayedPolicyReason);
    },
  );

  it("shows eventless hooks as blocked by their event declaration in info output", () => {
    const output = formatHookInfo(createEventlessHookReport().hooks[0], "session-memory", {});

    expect(output).toContain("No events defined");
    expect(output).toContain("Blocked reason: no events defined");
    expect(output).not.toContain("Missing requirements");
  });

  it("keeps missing requirement hooks labeled as missing requirements in info output", () => {
    const output = formatHookInfo(
      createMissingRequirementHookReport().hooks[0],
      "session-memory",
      {},
    );

    expect(output).toContain("Missing requirements");
    expect(output).toContain("DEMO_HOOK_TOKEN");
  });

  it("labels hooks status output", () => {
    const output = formatHooksCheck(report, {});
    expect(output).toContain("Hooks Status");
  });

  it("classifies eventless hooks as not ready in human check output", () => {
    const output = formatHooksCheck(createEventlessHookReport(), {});

    expect(output).toContain("Ready: 0");
    expect(output).toContain("Not ready: 1");
    expect(output).toContain("session-memory - no events defined");
  });

  it("classifies eventless hooks as not eligible in JSON check output", () => {
    const output = JSON.parse(formatHooksCheck(createEventlessHookReport(), { json: true }));

    expect(output).toMatchObject({
      total: 1,
      eligible: 0,
      notEligible: 1,
      hooks: {
        eligible: [],
        notEligible: [
          {
            name: "session-memory",
            blockedReason: "no events defined",
          },
        ],
      },
    });
  });

  it("labels plugin-managed hooks with plugin id", () => {
    const pluginReport = createPluginManagedHookReport();

    const output = formatHooksList(pluginReport, {});
    expect(output).toContain("plugin:voice-call");
  });

  it("warns about unknown events in hook info", () => {
    const typoReport: HookStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedHooksDir: "/tmp/hooks",
      hooks: [
        {
          ...expectDefined(report.hooks[0], "report.hooks[0] test invariant"),
          name: "typo-hook",
          events: ["command:nwe", "command:new"],
          unknownEvents: ["command:nwe"],
        },
      ],
    };

    const output = formatHookInfo(typoReport.hooks[0], "typo-hook", {});
    expect(output).toContain("Event not emitted by core (likely typo): command:nwe");
  });

  it("shows plugin-managed details in hook info", () => {
    const pluginReport = createPluginManagedHookReport();

    const output = formatHookInfo(pluginReport.hooks[0], "plugin-hook", {});
    expect(output).toContain("voice-call");
    expect(output).toContain("Managed by plugin");
  });

  it("forwards --force through the deprecated install alias", async () => {
    runPluginInstallCommandMock.mockResolvedValueOnce(undefined);
    const program = new Command().exitOverride();
    registerHooksCli(program);

    await program.parseAsync(["hooks", "install", "npm:demo-hooks", "--force"], {
      from: "user",
    });

    expect(runPluginInstallCommandMock).toHaveBeenCalledWith({
      raw: "npm:demo-hooks",
      allowInstallPolicyWarningPrompt: true,
      opts: expect.objectContaining({ force: true }),
    });
  });

  it("forwards install-policy acknowledgement through the deprecated install alias", async () => {
    runPluginInstallCommandMock.mockResolvedValueOnce(undefined);
    const program = new Command().exitOverride();
    registerHooksCli(program);

    await program.parseAsync(
      ["hooks", "install", "npm:demo-hooks", "--acknowledge-install-policy-warning"],
      { from: "user" },
    );

    expect(runPluginInstallCommandMock).toHaveBeenCalledWith({
      raw: "npm:demo-hooks",
      allowInstallPolicyWarningPrompt: true,
      opts: expect.objectContaining({ acknowledgeInstallPolicyWarning: true }),
    });
  });

  it("forwards install-policy acknowledgement through the deprecated update alias", async () => {
    runPluginUpdateCommandMock.mockResolvedValueOnce(undefined);
    const program = new Command().exitOverride();
    registerHooksCli(program);

    await program.parseAsync(
      ["hooks", "update", "demo-hooks", "--acknowledge-install-policy-warning"],
      { from: "user" },
    );

    expect(runPluginUpdateCommandMock).toHaveBeenCalledWith({
      id: "demo-hooks",
      opts: expect.objectContaining({ acknowledgeInstallPolicyWarning: true }),
    });
  });
});
