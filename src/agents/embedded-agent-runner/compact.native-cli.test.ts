import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const { runCliAgentMock } = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(async (_params: { preparedRunAdmission?: PreparedAgentRunAdmission }) => ({
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "native-session", provider: "claude-cli", model: "opus" },
    },
  })),
}));

vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));

const { testing } = await import("./compact.js");

function registerBackend(overrides: Partial<CliBackendPlugin> = {}) {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () =>
      [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          config: {
            command: "claude",
            args: ["-p"],
            resumeArgs: ["-p", "--resume", "{sessionId}"],
            input: "stdin",
            output: "jsonl",
            sessionMode: "existing",
          },
          bundleMcp: false,
          pluginId: "anthropic",
          ownsNativeCompaction: true,
          manualCompaction: {
            buildPrompt: (instructions?: string) =>
              instructions ? `/compact ${instructions}` : "/compact",
            input: "arg",
            validateOutput: () => ({ ok: true }),
          },
          ...overrides,
        },
      ] as never,
    resolvePluginSetupCliBackend: () => undefined,
  });
}

function compactParams(overrides: Record<string, unknown> = {}) {
  const dir = tempDirs.make("openclaw-compact-native-cli-");
  const cliSessionBinding = {
    sessionId: "native-session",
    authProfileId: "anthropic:subscription",
  };
  const sessionEntry = { execHost: "node", execNode: "paired-node" };
  return {
    sessionId: "openclaw-session",
    sessionKey: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "openclaw-session",
      sessionKey: "agent:main:main",
      storePath: join(dir, "openclaw.sqlite"),
    },
    sessionFile: "agent:main:main",
    agentId: "main",
    workspaceDir: join(dir, "workspace"),
    agentDir: join(dir, "agent"),
    config: {},
    provider: "anthropic",
    model: "opus",
    trigger: "manual",
    cliSessionId: "native-session",
    cliSessionBinding,
    sessionEntry,
    customInstructions: "keep decisions",
    preparedModelRuntime: {},
    ...overrides,
  } as never;
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  runCliAgentMock.mockClear();
});

describe("native CLI manual compaction", () => {
  it("resumes the bound backend session with the backend-owned command", async () => {
    registerBackend();

    const result = await testing.compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams(),
    });

    expect(result).toEqual({
      ok: true,
      compacted: true,
      reason: 'CLI backend "claude-cli" compacted its native session.',
    });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedRunAdmission: expect.objectContaining({
          operationalRunInstance: expect.objectContaining({
            runId: "openclaw-session:native-compact",
          }),
        }),
        prompt: "/compact keep decisions",
        provider: "claude-cli",
        modelProvider: "anthropic",
        cliSessionId: "native-session",
        cliSessionBinding: {
          sessionId: "native-session",
          authProfileId: "anthropic:subscription",
        },
        authProfileId: "anthropic:subscription",
        sessionEntry: { execHost: "node", execNode: "paired-node" },
        controlOperation: "compact",
        disableCliLiveSession: true,
        cleanupCliLiveSessionOnRunEnd: true,
        allowEmptyAssistantReplyAsSilent: true,
      }),
    );
    const preparedRunAdmission = runCliAgentMock.mock.calls[0]?.[0]?.preparedRunAdmission;
    if (!preparedRunAdmission) {
      throw new Error("native compaction did not prepare run admission");
    }
    await expect(preparedRunAdmission.admit("embedded")).rejects.toThrow(
      "prepared execution context is already closed",
    );
  });

  it("fails explicitly when an owning backend has no resumable session", async () => {
    registerBackend();

    const result = await testing.compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams({
        cliSessionId: undefined,
        cliSessionBinding: undefined,
      }),
    });

    expect(result).toMatchObject({ ok: false, compacted: false });
    expect(result?.reason).toContain("without a resumable native session");
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("leaves non-owning runtimes on the existing compaction path", async () => {
    registerBackend({ ownsNativeCompaction: false });

    await expect(
      testing.compactNativeCliSession({
        runtime: "claude-cli",
        compactParams: compactParams(),
      }),
    ).resolves.toBeUndefined();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });
});
