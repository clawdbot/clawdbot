import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { captureAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntry } from "./session-utils.js";
import { installGatewayTestHooks, prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";

describe("spawn input ownership transfer", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      const module = await import("./server-kernel.js");
      const create = module.createGatewayKernel;
      const capture = vi
        .spyOn(module, "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await create(...args);
          return kernel;
        });
      try {
        harness = await startGatewayServerHarness();
      } finally {
        capture.mockRestore();
      }
    },
    cleanup: async () => {
      await harness?.close();
    },
  });

  it.for([
    "before staging",
    "after acceptance",
    "child abort",
    "before reset",
    "live reset",
  ] as const)("keeps input authority at its current owner: %s", async (boundary, { signal }) => {
    await prepareGatewayReplyRuntimeForTest();
    const context = kernel.gatewayRequestContext;
    const cfg = context.getRuntimeConfig();
    const runId = randomUUID();
    const parentKey = `agent:main:parent:${runId}`;
    const childKey = `agent:main:subagent:${runId}`;
    const sessionId = `child-${runId}`;
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: "main", sessionKey: childKey },
      { sessionId, updatedAt: Date.now() },
    );
    const loaded = loadSessionEntry(childKey, { agentId: "main" });
    const admission = prepareAgentRunAdmission({
      cfg,
      operationalRunInstance: createOperationalRunInstanceRef(`parent-${runId}`),
      facts: {
        runId: `parent-${runId}`,
        agentId: "main",
        ingress: { kind: "system", boundary: "spawn-input-proof", state: "present" },
      },
    });
    const admitted = await admission.admit("embedded");
    const guard = await withGatewayToolCallerIdentity(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey: parentKey,
      }),
      () => captureAgentToolSourceExecutionGuard(),
    );
    if (boundary === "before reset" || boundary === "live reset") {
      const before = loadSessionEntry(childKey, { agentId: "main" }).entry;
      let hookCalls = 0;
      const onReset = (event: import("../hooks/internal-hooks.js").InternalHookEvent) => {
        if (event.sessionKey !== childKey) {
          return;
        }
        hookCalls++;
        if (boundary === "before reset") {
          admission.close();
        }
      };
      registerInternalHook("command:new", onReset);
      try {
        const reset = dispatchGatewayMethodInProcess(
          "agent",
          { message: "/new", sessionKey: childKey, idempotencyKey: runId },
          {
            forceSyntheticClient: true,
            syntheticScopes: ["operator.admin"],
            resolveGatewayContext: () => context,
            sessionMutationCommitGuard: guard,
          },
        );
        if (boundary === "before reset") {
          await expect(reset).rejects.toThrow("tool invocation authority is no longer active");
          expect(loadSessionEntry(childKey, { agentId: "main" }).entry).toEqual(before);
        } else {
          await expect(reset).resolves.toMatchObject({ status: "ok", summary: "completed" });
          const after = loadSessionEntry(childKey, { agentId: "main" }).entry;
          expect(after?.sessionId).toBe(sessionId);
          expect(after?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
        }
        expect(hookCalls).toBe(1);
      } finally {
        unregisterInternalHook("command:new", onReset);
        admission.close();
      }
      return;
    }
    const staged = createDeferred();
    const releaseWriter = createDeferred();
    const releaseExecution = createDeferred();
    const executionEntered = createDeferred();
    const release = () => {
      releaseWriter.resolve();
      releaseExecution.resolve();
    };
    signal.addEventListener("abort", release, { once: true });
    let writer: Promise<unknown> | undefined;
    let execution: Promise<void> | undefined;
    let prepared:
      | import("./agent-turn/agent-run-admission-phase.js").PreparedAgentRunDispatch
      | undefined;
    const executionModule = await import("./agent-turn/agent-run-execution-phase.js");
    const execute = executionModule.startAgentRunExecution;
    const executionSpy = vi
      .spyOn(executionModule, "startAgentRunExecution")
      .mockImplementationOnce((params) => {
        prepared = params.prepared;
        executionEntered.resolve();
        execution = releaseExecution.promise.then(() => execute(params));
        return execution;
      });
    const stage = sessionAccessor.stageSessionPendingInput;
    const stageSpy = vi
      .spyOn(sessionAccessor, "stageSessionPendingInput")
      .mockImplementationOnce(async (...args) => {
        if (boundary === "before staging") {
          const entered = createDeferred();
          writer = runExclusiveSqliteSessionWrite(
            resolveSqliteStoreScope(loaded.storePath, { agentId: "main" }),
            async () => {
              entered.resolve();
              await releaseWriter.promise;
            },
          );
          await entered.promise;
        }
        const pending = stage(...args);
        staged.resolve();
        return await pending;
      });
    let dispatch: Promise<unknown> | undefined;
    try {
      dispatch = dispatchGatewayMethodInProcess(
        "agent",
        { message: "synthetic staged child input", sessionKey: childKey, idempotencyKey: runId },
        {
          forceSyntheticClient: true,
          resolveGatewayContext: () => context,
          sessionMutationCommitGuard: guard,
        },
      );
      const outcome = dispatch.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await Promise.race([
        staged.promise,
        outcome.then((value) => {
          if ("error" in value) {
            throw value.error;
          }
          throw new Error(`Dispatch ended before staging: ${JSON.stringify(value)}`);
        }),
      ]);
      if (boundary === "before staging") {
        admission.close();
        releaseWriter.resolve();
        expect(await outcome).toHaveProperty(
          "error.message",
          "tool invocation authority is no longer active",
        );
        expect(prepared).toBeUndefined();
        expect(
          listSessionPendingInputs({
            agentId: "main",
            sessionKey: childKey,
            sessionId,
            storePath: loaded.storePath,
          }).total,
        ).toBe(0);
      } else {
        expect(await outcome).toHaveProperty("value.status", "accepted");
        await executionEntered.promise;
        const recorder = prepared!.userTurn.recorder!;
        expect(recorder.getPendingInputMessage?.()).toBeDefined();
        admission.close();
        expect(() => guard()).toThrow("tool invocation authority is no longer active");
        if (boundary === "child abort") {
          prepared!.activeRunAbort.controller.abort(new Error("child stopped"));
          expect(() => recorder.withPendingInput!(() => undefined)).toThrow("child stopped");
        } else {
          const persisted = await recorder.withPendingInput!(() => recorder.persistApproved());
          expect(persisted?.appended).toBe(true);
          expect(persisted?.message.content).toBe("synthetic staged child input");
          expect(
            listSessionPendingInputs({
              agentId: "main",
              sessionKey: childKey,
              sessionId,
              storePath: loaded.storePath,
            }).total,
          ).toBe(0);
        }
      }
    } finally {
      release();
      await Promise.allSettled([writer, dispatch, execution]);
      admission.close();
      stageSpy.mockRestore();
      executionSpy.mockRestore();
      signal.removeEventListener("abort", release);
    }
  });
});
