// Doctor workspace status tests cover workspace inspection and status output.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginVersionDriftReport } from "../plugins/plugin-version-drift.js";
import {
  createPluginLoadResult,
  createPluginRecord,
  createTypedHook,
} from "../plugins/status.test-fixtures.js";
import {
  collectWorkspaceStatusHealthFindings,
  noteWorkspaceStatus,
} from "./doctor-workspace-status.js";

const mocks = vi.hoisted(() => ({
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  buildPluginRegistrySnapshotReport: vi.fn(),
  buildPluginCompatibilityWarnings: vi.fn(),
  listTaskFlowRecords: vi.fn<() => unknown[]>(() => []),
  listTasksForFlowId: vi.fn<(flowId: string) => unknown[]>((_flowId: string) => []),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: unknown[]) => mocks.resolveAgentWorkspaceDir(...args),
  resolveDefaultAgentId: (...args: unknown[]) => mocks.resolveDefaultAgentId(...args),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginRegistrySnapshotReport: (...args: unknown[]) =>
    mocks.buildPluginRegistrySnapshotReport(...args),
  buildPluginCompatibilityWarnings: (...args: unknown[]) =>
    mocks.buildPluginCompatibilityWarnings(...args),
}));

vi.mock("../tasks/task-flow-runtime-internal.js", () => ({
  listTaskFlowRecords: () => mocks.listTaskFlowRecords(),
}));

vi.mock("../tasks/runtime-internal.js", () => ({
  listTasksForFlowId: (flowId: string) => mocks.listTasksForFlowId(flowId),
}));

async function runNoteWorkspaceStatusForTest(
  loadResult: ReturnType<typeof createPluginLoadResult>,
  compatibilityWarnings: string[] = [],
  opts?: {
    cfg?: OpenClawConfig;
    pluginVersionDrift?: PluginVersionDriftReport;
    flows?: unknown[];
    tasksByFlowId?: (flowId: string) => unknown[];
  },
) {
  const cfg: OpenClawConfig = opts?.cfg ?? {};
  mocks.resolveDefaultAgentId.mockReturnValue("default");
  mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
  mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
    workspaceDir: "/workspace",
    ...loadResult,
  });
  mocks.buildPluginCompatibilityWarnings.mockReturnValue(compatibilityWarnings);
  mocks.listTaskFlowRecords.mockReturnValue(opts?.flows ?? []);
  mocks.listTasksForFlowId.mockImplementation((flowId: string) =>
    opts?.tasksByFlowId ? opts.tasksByFlowId(flowId) : [],
  );

  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  noteWorkspaceStatus(cfg, {
    pluginVersionDrift: opts?.pluginVersionDrift,
  });
  return noteSpy;
}

describe("noteWorkspaceStatus", () => {
  it("warns when plugins use legacy compatibility paths", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "legacy-plugin",
            name: "Legacy Plugin",
            hookCount: 1,
          }),
        ],
        typedHooks: [
          createTypedHook({ pluginId: "legacy-plugin", hookName: "before_agent_start" }),
        ],
      }),
    );
    try {
      expect(mocks.buildPluginRegistrySnapshotReport).toHaveBeenCalledWith({
        config: {},
        workspaceDir: "/workspace",
      });
      const compatibilityCalls = noteSpy.mock.calls.filter(
        ([, title]) => title === "Plugin compatibility",
      );
      expect(compatibilityCalls).toHaveLength(0);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("omits healthy plugin inventory", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "claude-bundle",
            name: "Claude Bundle",
            source: "/tmp/claude-bundle",
            format: "bundle",
            bundleFormat: "claude",
            bundleCapabilities: ["skills", "commands", "agents"],
          }),
        ],
      }),
    );
    try {
      expect(noteSpy.mock.calls.filter(([, title]) => title === "Plugins")).toHaveLength(0);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("lists only errored plugin ids in deterministic order with truncation", async () => {
    const pluginIds = [
      "zulu",
      "bravo",
      "alpha",
      "lima",
      "charlie",
      "kilo",
      "delta",
      "juliet",
      "echo",
      "india",
      "foxtrot",
      "hotel",
    ];
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: pluginIds.map((id) => createPluginRecord({ id, status: "error" })),
      }),
    );
    try {
      const pluginCalls = noteSpy.mock.calls.filter(([, title]) => title === "Plugins");
      expect(pluginCalls).toHaveLength(1);
      const [body] = expectDefined(pluginCalls[0], "(pluginCalls)[0] test invariant");
      expect(body).toBe(
        [
          "Errors: 12",
          "- alpha",
          "- bravo",
          "- charlie",
          "- delta",
          "- echo",
          "- foxtrot",
          "- hotel",
          "- india",
          "- juliet",
          "- kilo",
          "- ...",
        ].join("\n"),
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("collects plugin version drift as structured findings", async () => {
    mocks.resolveDefaultAgentId.mockReturnValue("default");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
    mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      ...createPluginLoadResult({ plugins: [] }),
    });
    mocks.buildPluginCompatibilityWarnings.mockReturnValue([]);
    mocks.listTaskFlowRecords.mockReturnValue([]);

    const findings = collectWorkspaceStatusHealthFindings(
      {
        plugins: { entries: { codex: { enabled: true } } },
      },
      {
        pluginVersionDrift: {
          gatewayVersion: "2026.6.1",
          drifts: [
            {
              pluginId: "codex",
              installedVersion: "2026.5.30-beta.1",
              gatewayVersion: "2026.6.1",
              source: "npm",
            },
          ],
        },
      },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/workspace-status",
        severity: "warning",
        path: "plugins.entries.codex",
        target: "codex",
        requirement: "plugin-version-drift",
        message: expect.stringContaining("2026.5.30-beta.1"),
        fixHint: expect.stringContaining("openclaw plugins update codex"),
      }),
    ]);
  });

  it("collects compatibility warnings, plugin diagnostics, and TaskFlow recovery findings", async () => {
    mocks.resolveDefaultAgentId.mockReturnValue("default");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
    mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      ...createPluginLoadResult({
        plugins: [],
        diagnostics: [
          {
            level: "error",
            pluginId: "broken-plugin",
            message: "channel setup failed",
            source: "/tmp/plugin.json",
            code: "channel-setup-failure",
          },
        ],
      }),
    });
    mocks.buildPluginCompatibilityWarnings.mockReturnValue([
      "legacy-plugin still uses legacy before_agent_start",
    ]);
    mocks.listTaskFlowRecords.mockReturnValue([
      {
        flowId: "flow-123",
        syncMode: "managed",
        status: "blocked",
        blockedTaskId: "task-missing",
      },
      {
        flowId: "flow-history",
        syncMode: "task_mirrored",
        status: "blocked",
        blockedTaskId: "task-pruned",
        endedAt: 100,
      },
    ]);
    mocks.listTasksForFlowId.mockReturnValue([]);

    const findings = collectWorkspaceStatusHealthFindings({});

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/workspace-status",
        severity: "warning",
        path: "plugins",
        requirement: "plugin-compatibility",
        message: "legacy-plugin still uses legacy before_agent_start",
      }),
      expect.objectContaining({
        checkId: "core/doctor/workspace-status",
        severity: "error",
        path: "plugins.entries.broken-plugin",
        target: "broken-plugin",
        requirement: "channel-setup-failure",
        source: "/tmp/plugin.json",
        message: "channel setup failed",
      }),
      expect.objectContaining({
        checkId: "core/doctor/workspace-status",
        severity: "warning",
        path: "tasks.flows",
        target: "flow-123",
        requirement: "taskflow-recovery",
        message: expect.stringContaining("task-missing"),
        fixHint: expect.stringContaining("openclaw tasks flow show flow-123"),
      }),
    ]);
  });

  it("surfaces active official managed plugin version drift", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "codex",
            name: "Codex",
            origin: "global",
            source: "/tmp/codex/index.js",
          }),
        ],
      }),
      [],
      {
        cfg: {
          plugins: {
            entries: {
              codex: { enabled: true },
            },
          },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.6.1",
          drifts: [
            {
              pluginId: "codex",
              installedVersion: "2026.5.30-beta.1",
              gatewayVersion: "2026.6.1",
              source: "npm",
            },
          ],
        },
      },
    );
    try {
      const driftCalls = noteSpy.mock.calls.filter(([, title]) => title === "Plugin version drift");
      expect(driftCalls).toHaveLength(1);
      const [body] = expectDefined(driftCalls[0], "(driftCalls)[0] test invariant");
      expect(body).toContain("1 active official plugin not on OpenClaw 2026.6.1");
      expect(body).toContain("codex: 2026.5.30-beta.1 (npm) -> expected 2026.6.1");
      expect(body).toContain("openclaw plugins update codex");
      expect(body).toContain("openclaw gateway restart");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("uses package-version update commands for exact npm plugin drift", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "brave",
            name: "Brave",
            origin: "global",
            source: "/tmp/brave/index.js",
          }),
        ],
      }),
      [],
      {
        cfg: {
          plugins: {
            entries: {
              brave: { enabled: true },
            },
          },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.6.10-beta.1",
          drifts: [
            {
              pluginId: "brave",
              installedVersion: "2026.6.9",
              gatewayVersion: "2026.6.10-beta.1",
              source: "npm",
              packageName: "@openclaw/brave-plugin",
              spec: "@openclaw/brave-plugin@2026.6.9",
            },
          ],
        },
      },
    );
    try {
      const driftCalls = noteSpy.mock.calls.filter(([, title]) => title === "Plugin version drift");
      expect(driftCalls).toHaveLength(1);
      const [body] = expectDefined(driftCalls[0], "(driftCalls)[0] test invariant");
      expect(body).toContain("openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1");
      expect(body).not.toContain("openclaw plugins update brave");
      expect(body).toContain("openclaw gateway restart");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("omits plugin version drift when no daemon status report is supplied", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "codex",
            name: "Codex",
            origin: "global",
            source: "/tmp/codex/index.js",
          }),
        ],
      }),
      [],
      {
        cfg: {
          gateway: {
            mode: "remote",
          },
          plugins: {
            entries: {
              codex: { enabled: true },
            },
          },
        },
      },
    );
    try {
      expect(noteSpy.mock.calls.map(([, title]) => title)).not.toContain("Plugin version drift");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("omits plugin compatibility note when no legacy compatibility paths are present", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "modern-plugin",
            name: "Modern Plugin",
            providerIds: ["modern"],
          }),
        ],
      }),
    );
    try {
      expect(noteSpy.mock.calls.map(([, title]) => title)).not.toContain("Plugin compatibility");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("passes the shared status report into compatibility warnings", async () => {
    const loadResult = createPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "legacy-plugin",
          name: "Legacy Plugin",
          hookCount: 1,
        }),
      ],
      typedHooks: [createTypedHook({ pluginId: "legacy-plugin", hookName: "before_agent_start" })],
    });
    const noteSpy = await runNoteWorkspaceStatusForTest(loadResult, [
      "legacy-plugin still uses legacy before_agent_start",
    ]);
    try {
      expect(mocks.buildPluginRegistrySnapshotReport).toHaveBeenCalledWith({
        config: {},
        workspaceDir: "/workspace",
      });
      expect(mocks.buildPluginCompatibilityWarnings).toHaveBeenCalledWith({
        config: {},
        workspaceDir: "/workspace",
        report: {
          workspaceDir: "/workspace",
          ...loadResult,
        },
      });
      const compatibilityCalls = noteSpy.mock.calls.filter(
        ([, title]) => title === "Plugin compatibility",
      );
      expect(compatibilityCalls).toHaveLength(1);
      const [body] = expectDefined(compatibilityCalls[0], "(compatibilityCalls)[0] test invariant");
      expect(body).toContain("legacy-plugin still uses legacy before_agent_start");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("adds TaskFlow recovery hints for broken blocked flows", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(createPluginLoadResult(), [], {
      flows: [
        {
          flowId: "flow-123",
          syncMode: "managed",
          ownerKey: "agent:main:main",
          revision: 0,
          status: "blocked",
          notifyPolicy: "done_only",
          goal: "Investigate PR batch",
          blockedTaskId: "task-missing",
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      tasksByFlowId: () => [],
    });
    try {
      const recoveryCalls = noteSpy.mock.calls.filter(([, title]) => title === "TaskFlow recovery");
      expect(recoveryCalls).toHaveLength(1);
      const [body] = expectDefined(recoveryCalls[0], "(recoveryCalls)[0] test invariant");
      expect(body).toContain("flow-123");
      expect(body).toContain("openclaw tasks flow show <flow-id>");
    } finally {
      noteSpy.mockRestore();
    }
  });
});
