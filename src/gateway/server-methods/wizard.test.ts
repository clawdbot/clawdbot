// Wizard server-method tests cover stable lifecycle errors for process-local sessions.
import fs from "node:fs/promises";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";

const setupTargetLock = vi.hoisted(() => ({
  beforeRelease: undefined as Promise<void> | undefined,
  releaseReached: undefined as (() => void) | undefined,
}));

vi.mock("../../infra/file-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/file-lock.js")>(
    "../../infra/file-lock.js",
  );
  return {
    ...actual,
    withFileLock: async <T>(
      filePath: string,
      options: Parameters<typeof actual.acquireFileLock>[1],
      run: () => Promise<T>,
    ): Promise<T> => {
      const lock = await actual.acquireFileLock(filePath, options);
      try {
        return await run();
      } finally {
        setupTargetLock.releaseReached?.();
        await setupTargetLock.beforeRelease;
        await lock.release();
      }
    },
  };
});

import {
  runExclusiveSystemAgentSetupActivation,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { type SetupWizardRunner, wizardHandlers } from "./wizard.js";

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

function createWizardContext(
  wizardRunner: NonNullable<GatewayRequestHandlerOptions["context"]>["wizardRunner"],
) {
  const wizardSessions = new Map();
  return {
    wizardSessions,
    wizardRunner,
    findRunningWizard: () => undefined,
    purgeWizardSession: (sessionId: string) => wizardSessions.delete(sessionId),
  };
}

function readSuccessfulResponse(respond: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(respond).toHaveBeenCalledOnce();
  const [ok, result] = respond.mock.calls[0] ?? [];
  expect(ok).toBe(true);
  expect(result).toBeDefined();
  return result as Record<string, unknown>;
}

async function invokeWizard(
  method: "wizard.start" | "wizard.next",
  params: Record<string, unknown>,
  context: ReturnType<typeof createWizardContext>,
): Promise<Record<string, unknown>> {
  const respond = vi.fn();
  const handler = expectDefined(wizardHandlers[method], `wizardHandlers[${method}] test invariant`);
  await handler({ params, respond, context } as never);
  return readSuccessfulResponse(respond);
}

async function cancelWizardSessions(
  sessions: Map<string, import("../../wizard/session.js").WizardSession>,
) {
  for (const session of sessions.values()) {
    session.cancel();
    await whenAdmittedWizardSessionSettled(session);
  }
}

describe("wizard session lookup", () => {
  it.each([
    { method: "wizard.next", params: { sessionId: "expired" } },
    { method: "wizard.cancel", params: { sessionId: "expired" } },
    { method: "wizard.status", params: { sessionId: "expired" } },
  ] as const)("returns structured details from $method", async ({ method, params }) => {
    const respond = vi.fn();
    const handler = expectDefined(
      wizardHandlers[method],
      `wizardHandlers[${method}] test invariant`,
    );

    await handler({
      req: { type: "req", id: "wizard-missing", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { wizardSessions: new Map() } as never,
    } as GatewayRequestHandlerOptions);

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "wizard not found",
      details: { code: "WIZARD_NOT_FOUND" },
    });
  });
});

describe("hosted wizard runtime isolation", () => {
  it.each([
    { flow: "setup", exitCode: 0, status: "done" },
    { flow: "setup", exitCode: 23, status: "error" },
    { flow: "channels", exitCode: 0, status: "done" },
    { flow: "channels", exitCode: 23, status: "error" },
  ] as const)(
    "contains a $flow wizard exit $exitCode without exiting the Gateway",
    async ({ flow, exitCode, status }) => {
      const processExit = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`Gateway process exit ${code}`);
      });
      const tracker = createWizardSessionTracker();
      const runner = async (runtime: RuntimeEnv, prompter: WizardPrompter) => {
        await prompter.outro("wizard complete");
        runtime.exit(exitCode);
      };
      const context = {
        ...tracker,
        wizardRunner: async (_opts: unknown, runtime: RuntimeEnv, prompter: WizardPrompter) =>
          runner(runtime, prompter),
        channelWizardRunner: async (
          _opts: unknown,
          runtime: RuntimeEnv,
          prompter: WizardPrompter,
        ) => runner(runtime, prompter),
      };

      try {
        const startRespond = vi.fn();
        await expectDefined(
          wizardHandlers["wizard.start"],
          "wizard.start test invariant",
        )({
          params: flow === "channels" ? { flow } : { mode: "local" },
          respond: startRespond,
          context,
        } as never);
        expect(startRespond).toHaveBeenCalledOnce();
        const [, start] = startRespond.mock.calls[0] ?? [];
        expect(start).toMatchObject({ done: false, status: "running" });

        const nextRespond = vi.fn();
        await expectDefined(
          wizardHandlers["wizard.next"],
          "wizard.next test invariant",
        )({
          params: {
            sessionId: start.sessionId,
            answer: { stepId: start.step.id, value: null },
          },
          respond: nextRespond,
          context,
        } as never);
        expect(nextRespond).toHaveBeenCalledOnce();
        const [, result] = nextRespond.mock.calls[0] ?? [];
        expect(result).toMatchObject({ done: true, status });
        if (exitCode !== 0) {
          expect(result.error).toContain(String(exitCode));
        }
        expect(processExit).not.toHaveBeenCalled();
      } finally {
        processExit.mockRestore();
      }
    },
  );
});

describe("wizard setup ownership", () => {
  it("rejects classic setup while structured setup owns admission, then permits it", async () => {
    const structuredStarted = createDeferred();
    const releaseStructured = createDeferred();
    const structured = runExclusiveSystemAgentSetupActivation(async () => {
      structuredStarted.resolve();
      await releaseStructured.promise;
    });
    await structuredStarted.promise;
    const tracker = createWizardSessionTracker();
    const wizardRunner = vi.fn(async (_opts, _runtime, prompter: WizardPrompter) => {
      await prompter.note("ready");
    });
    const context = { ...tracker, wizardRunner };

    const blockedRespond = vi.fn();
    await expectDefined(
      wizardHandlers["wizard.start"],
      "wizard.start test invariant",
    )({
      params: { mode: "local" },
      respond: blockedRespond,
      context,
    } as never);
    expect(blockedRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(wizardRunner).not.toHaveBeenCalled();

    releaseStructured.resolve();
    await structured;
    const admittedRespond = vi.fn();
    await expectDefined(
      wizardHandlers["wizard.start"],
      "wizard.start test invariant",
    )({
      params: { mode: "local" },
      respond: admittedRespond,
      context,
    } as never);
    expect(admittedRespond.mock.calls[0]?.[1]).toMatchObject({ status: "running" });
    const session = expectDefined(
      [...tracker.wizardSessions.values()][0],
      "admitted classic setup session",
    );
    session.cancel();
    await whenAdmittedWizardSessionSettled(session);
  });

  it("makes structured setup retry while a classic runner owns admission, then releases", async () => {
    const runnerSettled = createDeferred();
    const tracker = createWizardSessionTracker();
    const context = {
      ...tracker,
      wizardRunner: async (_opts: unknown, _runtime: RuntimeEnv, prompter: WizardPrompter) => {
        prompter.progress("working");
        await runnerSettled.promise;
      },
    };
    const startRespond = vi.fn();
    await expectDefined(
      wizardHandlers["wizard.start"],
      "wizard.start test invariant",
    )({
      params: { mode: "local" },
      respond: startRespond,
      context,
    } as never);
    expect(startRespond.mock.calls[0]?.[1]).toMatchObject({ status: "running" });

    const activateRespond = vi.fn();
    await expectDefined(
      systemAgentHandlers["openclaw.setup.activate"],
      "openclaw.setup.activate test invariant",
    )({ params: { kind: "claude-cli" }, respond: activateRespond } as never);
    expect(activateRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );

    runnerSettled.resolve();
    const session = expectDefined(
      [...tracker.wizardSessions.values()][0],
      "active classic setup session",
    );
    await whenAdmittedWizardSessionSettled(session);
    const structuredTask = vi.fn(async () => "ok");
    await expect(runExclusiveSystemAgentSetupActivation(structuredTask)).resolves.toBe("ok");
    expect(structuredTask).toHaveBeenCalledOnce();
  });

  it("retains gateway work admission between requests until the wizard settles", async () => {
    resetGatewayWorkAdmission();
    const runnerSettled = createDeferred();
    const tracker = createWizardSessionTracker();
    const context = {
      ...tracker,
      wizardRunner: async (_opts: unknown, _runtime: RuntimeEnv, prompter: WizardPrompter) => {
        prompter.progress("working");
        await runnerSettled.promise;
      },
    };

    try {
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        const respond = vi.fn();
        await expectDefined(
          wizardHandlers["wizard.start"],
          "wizard.start test invariant",
        )({ params: { mode: "local" }, respond, context } as never);
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "running" });
      });

      expect(getActiveGatewayRootWorkCount()).toBe(1);
      runnerSettled.resolve();
      await vi.waitFor(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    } finally {
      runnerSettled.resolve();
      resetGatewayWorkAdmission();
    }
  });

  it("cleans up detached wizard owners when setup lock release fails", async () => {
    resetGatewayWorkAdmission();
    const runnerSettled = createDeferred();
    const tracker = createWizardSessionTracker();
    const context = {
      ...tracker,
      wizardRunner: async (_opts: unknown, _runtime: RuntimeEnv, prompter: WizardPrompter) => {
        prompter.progress("working");
        await runnerSettled.promise;
      },
    };
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    let lockPath: string | undefined;

    try {
      let sessionId = "";
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        const respond = vi.fn();
        await expectDefined(
          wizardHandlers["wizard.start"],
          "wizard.start test invariant",
        )({ params: { mode: "local" }, respond, context } as never);
        sessionId = String(respond.mock.calls[0]?.[1]?.sessionId ?? "");
      });
      expect(sessionId).not.toBe("");
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      const cancelRespond = vi.fn();
      await expectDefined(
        wizardHandlers["wizard.cancel"],
        "wizard.cancel test invariant",
      )({ params: { sessionId }, respond: cancelRespond, context } as never);
      expect(cancelRespond.mock.calls[0]?.[1]).toMatchObject({ status: "cancelled" });

      const releaseError = new Error("setup lock release failed");
      __setFsSafeTestHooksForTest({
        beforeSidecarLockSnapshotOpen: (candidate) => {
          lockPath = candidate;
          throw releaseError;
        },
      });
      runnerSettled.resolve();
      const session = expectDefined(
        tracker.wizardSessions.get(sessionId),
        "cancelled setup session",
      );
      await expect(whenAdmittedWizardSessionSettled(session)).rejects.toBe(releaseError);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect.soft(unhandledRejections).toEqual([]);
      expect.soft(getActiveGatewayRootWorkCount()).toBe(0);
      expect.soft(tracker.wizardSessions.has(sessionId)).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      __setFsSafeTestHooksForTest(undefined);
      runnerSettled.resolve();
      resetGatewayWorkAdmission();
      if (lockPath) {
        await fs.rm(lockPath, { force: true });
      }
    }
  });

  it("blocks a replacement wizard until the cancelled runner settles", async () => {
    const runnerSettled = createDeferred();
    const tracker = createWizardSessionTracker();
    const context = {
      ...tracker,
      wizardRunner: async (_opts: unknown, _runtime: RuntimeEnv, prompter: WizardPrompter) => {
        prompter.progress("working");
        await runnerSettled.promise;
      },
    };

    const startRespond = vi.fn();
    await expectDefined(
      wizardHandlers["wizard.start"],
      "wizard.start test invariant",
    )({
      params: { mode: "local" },
      respond: startRespond,
      context,
    } as never);
    const [, start] = startRespond.mock.calls[0] ?? [];
    expect(start).toMatchObject({ status: "running" });

    const cancelRespond = vi.fn();
    await expectDefined(
      wizardHandlers["wizard.cancel"],
      "wizard.cancel test invariant",
    )({
      params: { sessionId: start.sessionId },
      respond: cancelRespond,
      context,
    } as never);
    expect(cancelRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "cancelled" }),
      undefined,
    );

    const blockedRespond = vi.fn();
    await expectDefined(
      wizardHandlers["wizard.start"],
      "wizard.start test invariant",
    )({
      params: { mode: "local" },
      respond: blockedRespond,
      context,
    } as never);
    expect(blockedRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );

    runnerSettled.resolve();
    await vi.waitFor(() => {
      expect(tracker.wizardSessions.has(start.sessionId)).toBe(false);
    });

    const replacementRespond = vi.fn();
    await expectDefined(
      wizardHandlers["wizard.start"],
      "wizard.start test invariant",
    )({
      params: { mode: "local" },
      respond: replacementRespond,
      context,
    } as never);
    expect(replacementRespond.mock.calls[0]?.[1]).toMatchObject({ status: "running" });

    await cancelWizardSessions(tracker.wizardSessions);
  });

  it("settles setup admission before returning a terminal wizard status", async () => {
    const runnerSettled = createDeferred();
    const releaseSetupTargetLock = createDeferred();
    const setupTargetLockReleaseReached = createDeferred();
    setupTargetLock.beforeRelease = releaseSetupTargetLock.promise;
    setupTargetLock.releaseReached = setupTargetLockReleaseReached.resolve;
    const tracker = createWizardSessionTracker();
    const context = {
      ...tracker,
      wizardRunner: async (_opts: unknown, _runtime: RuntimeEnv, prompter: WizardPrompter) => {
        prompter.progress("working");
        await runnerSettled.promise;
      },
    };
    let admittedSession: import("../../wizard/session.js").WizardSession | undefined;

    try {
      const startRespond = vi.fn();
      await expectDefined(
        wizardHandlers["wizard.start"],
        "wizard.start test invariant",
      )({ params: { mode: "local" }, respond: startRespond, context } as never);
      const [, start] = startRespond.mock.calls[0] ?? [];
      expect(start).toMatchObject({ status: "running" });
      admittedSession = expectDefined(
        tracker.wizardSessions.get(start.sessionId),
        "admitted classic setup session",
      );

      runnerSettled.resolve();
      await setupTargetLockReleaseReached.promise;
      expect(admittedSession.getStatus()).toBe("done");
      await expect(runExclusiveSystemAgentSetupActivation(async () => undefined)).rejects.toThrow(
        "setup is already in progress",
      );

      const replacementRespond = vi.fn();
      let replacementStart: Promise<void> | undefined;
      const statusRespond = vi.fn(() => {
        replacementStart = Promise.resolve(
          expectDefined(
            wizardHandlers["wizard.start"],
            "wizard.start test invariant",
          )({ params: { mode: "local" }, respond: replacementRespond, context } as never),
        );
      });
      const statusTask = Promise.resolve(
        expectDefined(
          wizardHandlers["wizard.status"],
          "wizard.status test invariant",
        )({ params: { sessionId: start.sessionId }, respond: statusRespond, context } as never),
      );

      await Promise.resolve();
      releaseSetupTargetLock.resolve();
      await statusTask;
      await vi.waitFor(() => expect(replacementStart).toBeDefined());
      await replacementStart;

      expect(statusRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "done" }),
        undefined,
      );
      expect(replacementRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "running" }),
        undefined,
      );
    } finally {
      runnerSettled.resolve();
      releaseSetupTargetLock.resolve();
      if (admittedSession) {
        await whenAdmittedWizardSessionSettled(admittedSession);
      }
      await cancelWizardSessions(tracker.wizardSessions);
      setupTargetLock.beforeRelease = undefined;
      setupTargetLock.releaseReached = undefined;
    }
  });

  it.each([
    { label: "false", params: { installDaemon: false }, expected: false },
    { label: "true", params: { installDaemon: true }, expected: true },
    { label: "omitted", params: {}, expected: undefined },
  ])("projects installDaemon when $label", async ({ params, expected }) => {
    let receivedInstallDaemon: boolean | undefined;
    const tracker = createWizardSessionTracker();
    const wizardRunner: SetupWizardRunner = async (opts, _runtime, prompter) => {
      receivedInstallDaemon = opts.installDaemon;
      await prompter.note("ready");
    };
    const respond = vi.fn();

    await expectDefined(
      wizardHandlers["wizard.start"],
      "wizard.start test invariant",
    )({
      params: { mode: "local", ...params },
      respond,
      context: { ...tracker, wizardRunner },
    } as never);

    expect(receivedInstallDaemon).toBe(expected);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ done: false, status: "running" });

    await cancelWizardSessions(tracker.wizardSessions);
  });
});

describe("wizard step serialization", () => {
  it("strips a sensitive initial value from wizard.start", async () => {
    const context = createWizardContext(async (_opts, _runtime, prompter) => {
      await prompter.text({
        message: "Bot token",
        sensitive: true,
        initialValue: "123456:REAL-SECRET",
      });
    });
    const result = await invokeWizard("wizard.start", {}, context);
    expect(result.step).toMatchObject({ sensitive: true });
    expect(result.step).not.toHaveProperty("initialValue");
    await cancelWizardSessions(context.wizardSessions);
  });

  it("keeps a plain default but strips the next sensitive one from wizard.next", async () => {
    const context = createWizardContext(async (_opts, _runtime, prompter) => {
      await prompter.text({
        message: "Display name",
        initialValue: "OpenClaw",
      });
      await prompter.text({
        message: "Bot token",
        sensitive: true,
        initialValue: "123456:REAL-SECRET",
      });
    });
    const startResult = await invokeWizard("wizard.start", {}, context);
    expect(startResult.step).toMatchObject({ initialValue: "OpenClaw" });
    const sessionId = startResult.sessionId;
    expect(typeof sessionId).toBe("string");

    const params = {
      sessionId,
      answer: {
        stepId: (startResult.step as { id: string }).id,
        value: "Renamed",
      },
    };
    const nextResult = await invokeWizard("wizard.next", params, context);
    expect(nextResult.step).toMatchObject({ sensitive: true });
    expect(nextResult.step).not.toHaveProperty("initialValue");
    await cancelWizardSessions(context.wizardSessions);
  });
});
