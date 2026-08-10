import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { normalizeCodexTrajectoryError } from "./trajectory.js";

setupRunAttemptTestHooks();

async function runInjectedFailure(promptError: unknown) {
  vi.stubEnv("OPENCLAW_TRAJECTORY", "1");
  const harness = createStartedThreadHarness();
  const params = createParams(
    path.join(tempDir, "session-failure-presence.jsonl"),
    path.join(tempDir, "workspace-failure-presence"),
  );
  const onAgentEvent = vi.fn();
  const trajectoryEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
  params.onAgentEvent = onAgentEvent;
  Object.assign(params, {
    trajectoryRecorder: {
      recordEvent: (type: string, data?: Record<string, unknown>) => {
        trajectoryEvents.push({ type, data });
      },
      flush: async () => undefined,
    },
  });
  const originalBuildResult = Object.getOwnPropertyDescriptor(
    CodexAppServerEventProjector.prototype,
    "buildResult",
  )?.value as (
    this: CodexAppServerEventProjector,
    ...args: Parameters<CodexAppServerEventProjector["buildResult"]>
  ) => ReturnType<CodexAppServerEventProjector["buildResult"]>;
  vi.spyOn(CodexAppServerEventProjector.prototype, "buildResult").mockImplementation(function (
    this: CodexAppServerEventProjector,
    ...args
  ) {
    Object.assign(this as unknown as Record<string, unknown>, {
      promptError,
      promptErrorSource: "prompt",
    });
    return originalBuildResult.apply(this, args);
  });

  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");
  await harness.notify(
    itemNotification("item/started", {
      type: "commandExecution",
      id: "cmd-failure-presence",
      command: "pnpm test extensions/codex",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }),
  );
  await harness.notify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      turn: { id: "turn-1", status: "interrupted" },
    },
  });

  return { result: await run, onAgentEvent, trajectoryEvents };
}

describe("Codex app-server finalizer failure presence", () => {
  it.each([false, 0, "", null, undefined])(
    "preserves source failure payload %# through synthesis, finalization, and cleanup",
    async (promptError) => {
      const { result, onAgentEvent, trajectoryEvents } = await runInjectedFailure(promptError);
      expect(readAttemptTerminal(result)).toMatchObject({
        failed: true,
        promptFailure: { source: "prompt", error: promptError },
      });
      expect(JSON.stringify(result.messagesSnapshot)).toContain("without a matching tool.result");
      expect(
        onAgentEvent.mock.calls
          .map(([event]) => event)
          .find((event) => event.stream === "lifecycle" && event.data.phase === "error"),
      ).toBeDefined();
      const expectedFailure = {
        promptError: normalizeCodexTrajectoryError(promptError, true),
        promptErrorCategory: promptError === null ? "null" : typeof promptError,
        promptErrorSource: "prompt",
      };
      expect(
        trajectoryEvents
          .filter(({ type }) => type === "model.completed" || type === "session.ended")
          .map(({ type, data }) => ({
            type,
            promptError: data?.promptError,
            promptErrorCategory: data?.promptErrorCategory,
            promptErrorSource: data?.promptErrorSource,
          })),
      ).toEqual([
        { type: "model.completed", ...expectedFailure },
        { type: "session.ended", ...expectedFailure },
      ]);
    },
  );

  it.each([
    {
      label: "prototype-hostile proxy",
      promptError: new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("prototype trap");
          },
        },
      ),
      expectedError: "Unknown error",
      expectedCategory: "unknown",
    },
    {
      label: "throwing message accessor",
      promptError: Object.create(Error.prototype, {
        message: {
          get: () => {
            throw new Error("message trap");
          },
        },
      }),
      expectedError: "Error",
      expectedCategory: "Error",
    },
  ])(
    "keeps canonical terminal failure when trajectory sees a $label",
    async ({ promptError, expectedError, expectedCategory }) => {
      const { result, trajectoryEvents } = await runInjectedFailure(promptError);
      expect(readAttemptTerminal(result).failed).toBe(true);
      expect(
        trajectoryEvents
          .filter(({ type }) => type === "model.completed" || type === "session.ended")
          .map(({ type, data }) => ({
            type,
            promptError: data?.promptError,
            promptErrorCategory: data?.promptErrorCategory,
            promptErrorSource: data?.promptErrorSource,
          })),
      ).toEqual([
        {
          type: "model.completed",
          promptError: expectedError,
          promptErrorCategory: expectedCategory,
          promptErrorSource: "prompt",
        },
        {
          type: "session.ended",
          promptError: expectedError,
          promptErrorCategory: expectedCategory,
          promptErrorSource: "prompt",
        },
      ]);
    },
  );
});
