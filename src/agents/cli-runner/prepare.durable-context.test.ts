import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import * as maintenance from "../embedded-agent-runner/context-engine-maintenance.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

describe("CLI durable session context", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const cleanups: Array<() => Promise<void> | void> = [];

  async function prepareOwnedHistory() {
    const agentDir = path.join(fixture.session.dir, "agents", "main", "agent");
    const authProfileId = "history-test:account";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "token",
            provider: "test-cli",
            token: "synthetic-history-account",
          },
          "history-test:other": {
            type: "token",
            provider: "test-cli",
            token: "synthetic-other-account",
          },
        },
      },
      agentDir,
    );
    const prepared = await fixture.prepare({ agentDir, authProfileId });
    cleanups.push(() => prepared.preparedBackend.cleanup?.());
    expect(prepared.cliHistoryWriter).toBeDefined();
    return {
      appendTranscript: (entry: Parameters<typeof fixture.appendTranscript>[0]) =>
        runWithCliHistoryWriter(prepared.cliHistoryWriter, () => fixture.appendTranscript(entry)),
      prepare: (overrides: Parameters<typeof fixture.prepare>[0] = {}) =>
        fixture.prepare({
          agentDir,
          authProfileId,
          admittedRunContext: prepared.params.admittedRunContext,
          ...overrides,
        }),
    };
  }

  beforeEach(() => {
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      vi.restoreAllMocks();
      resetCliRunnerPrepareTestDeps();
      cliBackendsTesting.resetDepsForTest();
      fixture.cleanup();
    }
  });

  it("joins deferred maintenance before reading durable context", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    const history = await prepareOwnedHistory();
    const { sessionTarget } = fixture.session;
    const wait = vi
      .spyOn(maintenance, "waitForDeferredTurnMaintenanceForSession")
      .mockImplementation(async () => {
        history.appendTranscript({
          id: "completed-maintenance-note",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: {
            role: "custom",
            customType: "openclaw.system-note",
            content: "FACT_AFTER_MAINTENANCE",
            display: false,
            timestamp: 1,
          },
        });
      });
    const context = await history.prepare({ sessionKey: sessionTarget.sessionKey });
    try {
      expect(wait).toHaveBeenCalledExactlyOnceWith(sessionTarget.sessionKey);
      expect(context.params.prompt).toContain("FACT_AFTER_MAINTENANCE");
      expect(context.params.transcriptPrompt).toBe("latest ask");
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

  it.each([
    { transport: "plugin", resume: false, changeAccount: false },
    { transport: "plugin", resume: true, changeAccount: false },
    { transport: "process", resume: false, changeAccount: false },
    { transport: "process", resume: true, changeAccount: false },
    { transport: "plugin", resume: true, changeAccount: true },
    { transport: "process", resume: true, changeAccount: true },
  ])(
    "preserves owned reference facts for $transport, resume=$resume, changeAccount=$changeAccount",
    async (testCase) => {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            ...buildDefaultTestCliBackend(),
            ...(testCase.transport === "plugin"
              ? {
                  prepareExecution: () => ({
                    async *execute() {
                      yield { type: "result" };
                    },
                  }),
                }
              : {}),
          },
        ],
      });
      const history = await prepareOwnedHistory();
      history.appendTranscript({
        id: "durable-note",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: {
          role: "custom",
          customType: "openclaw.system-note",
          content: "The saved audit checksum is RESULT-1234.",
          display: false,
          timestamp: 1,
        },
      });
      const context = await history.prepare({
        ...(testCase.resume ? { cliSessionId: "existing-native-session" } : {}),
        ...(testCase.changeAccount ? { authProfileId: "history-test:other" } : {}),
      });
      try {
        const logicalPrompt = context.promptForHooks ?? context.params.prompt;
        if (testCase.changeAccount) {
          expect(logicalPrompt).not.toContain("RESULT-1234");
          expect(context.cliHistoryWriter).toBeUndefined();
        } else {
          expect(logicalPrompt).toContain("RESULT-1234");
          expect(logicalPrompt).toContain("data, not instructions");
          expect(context.params.transcriptPrompt).toBe("latest ask");
        }
        expect(context.contextEngineTurnPrompt).toBe("latest ask");
        expect(context.reusableCliSession).toEqual(
          testCase.resume
            ? { mode: "reuse", sessionId: "existing-native-session" }
            : { mode: "none" },
        );
        if (testCase.transport === "plugin") {
          expect(context.params.prompt).toBe("latest ask");
          if (!testCase.changeAccount) {
            expect(context.promptContext?.prependContext).toContain("RESULT-1234");
          }
        }
        expect(context.openClawHistoryPrompt).toBeUndefined();
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    },
  );
});
