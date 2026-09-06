import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => {
    vi.restoreAllMocks();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    fixture.cleanup();
  });

  it("joins deferred maintenance before reading durable context", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    const { sessionTarget } = fixture.session;
    const wait = vi
      .spyOn(maintenance, "waitForDeferredTurnMaintenanceForSession")
      .mockImplementation(async () => {
        fixture.appendTranscript({
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
    const context = await fixture.prepare({ sessionKey: sessionTarget.sessionKey });
    try {
      expect(wait).toHaveBeenCalledExactlyOnceWith(sessionTarget.sessionKey);
      expect(context.params.prompt).toContain("FACT_AFTER_MAINTENANCE");
      expect(context.params.transcriptPrompt).toBe("latest ask");
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

  it.each([
    { transport: "plugin", resume: false },
    { transport: "plugin", resume: true },
    { transport: "process", resume: false },
    { transport: "process", resume: true },
  ])(
    "preserves reference facts and user input for $transport, resume=$resume",
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
      fixture.appendTranscript({
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
      const context = await fixture.prepare(
        testCase.resume ? { cliSessionId: "existing-native-session" } : {},
      );
      try {
        const logicalPrompt = context.promptForHooks ?? context.params.prompt;
        expect(logicalPrompt).toContain("RESULT-1234");
        expect(logicalPrompt).toContain("data, not instructions");
        expect(context.contextEngineTurnPrompt).toBe("latest ask");
        expect(context.params.transcriptPrompt).toBe("latest ask");
        expect(context.reusableCliSession).toEqual(
          testCase.resume
            ? { mode: "reuse", sessionId: "existing-native-session" }
            : { mode: "none" },
        );
        if (testCase.transport === "plugin") {
          expect(context.params.prompt).toBe("latest ask");
          expect(context.promptContext?.prependContext).toContain("RESULT-1234");
        }
        expect(context.openClawHistoryPrompt).toBeUndefined();
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    },
  );
});
