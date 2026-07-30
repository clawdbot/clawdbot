// Wizard server-method tests cover stable lifecycle errors for process-local sessions.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { createDeferred } from "../../shared/deferred.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { type SetupWizardRunner, wizardHandlers } from "./wizard.js";

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

    for (const session of tracker.wizardSessions.values()) {
      session.cancel();
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

    for (const session of tracker.wizardSessions.values()) {
      session.cancel();
    }
  });
});
