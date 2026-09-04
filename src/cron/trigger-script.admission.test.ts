import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  closeAdmittedRunDelegatedAuthority,
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import { resolveToolSearchConfig } from "../agents/tool-search.js";
import { jsonResult, type AnyAgentTool } from "../agents/tools/common.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createExecutionStartedOwnerBinding } from "../audit/execution-owner-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

type HeadlessParams = Parameters<
  NonNullable<Parameters<typeof createCronScriptRuntime>[0]["runHeadless"]>
>[0];

function completed(value: unknown): CodeModeHeadlessResult {
  return { status: "completed", value, output: [], toolCallCount: 1 };
}

function toolRuntime(ctx: HeadlessParams["ctx"]) {
  return new ToolSearchRuntime(ctx, resolveToolSearchConfig(ctx.runtimeConfig), {
    prepareInput: true,
    validateInput: true,
  });
}

function prepareRuntime(config: OpenClawConfig, tool: AnyAgentTool) {
  return vi.fn(async () => ({
    tools: [tool],
    context: { config, agentId: "main", sessionKey: "agent:main:cron:probe" },
  }));
}

function probe(execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name: "probe",
    label: "Probe",
    description: "Observe the invocation owner",
    parameters: { type: "object", properties: {} },
    execute,
  };
}

describe("cron script admission", () => {
  it.each(["trigger", "payload"] as const)(
    "gives each warm %s invocation fresh authority and releases it after completion",
    async (mode) => {
      const config: OpenClawConfig = {};
      const admitted: AdmittedRunContext[] = [];
      const retained: HeadlessParams["ctx"][] = [];
      const started = vi.fn();
      const prepare = prepareRuntime(
        config,
        probe(async () => {
          const caller = getGatewayToolCallerIdentity();
          return jsonResult({
            owned: Boolean(caller?.operationalRunInstance && caller.approvalAuthority),
            runId: caller?.operationalRunInstance?.runId,
          });
        }),
      );
      const runtime = createCronScriptRuntime({
        config,
        prepareRuntime: prepare,
        runHeadless: async ({ ctx }) => {
          retained.push(ctx);
          const value = await toolRuntime(ctx).callValue("probe", {});
          return completed({ fire: false, state: value });
        },
      });
      for (let index = 0; index < 2; index += 1) {
        const params = {
          jobId: "same-job",
          script: "return result",
          state: null,
          executionIdentity: {
            ingress: {
              kind: "schedule" as const,
              boundary: "cron.isolated-agent",
              state: "present" as const,
            },
            onPostAdmission: (context: AdmittedRunContext) => admitted.push(context),
            onExecutionStarted: started,
          },
        };
        await expect(
          mode === "trigger" ? runtime.evaluateTrigger(params) : runtime.executePayload(params),
        ).resolves.toMatchObject({
          kind: mode === "trigger" ? "evaluated" : "completed",
          state: { owned: true },
        });
        expect(getAdmittedRunDelegatedAuthority(admitted[index]!)).toBeUndefined();
        await expect(toolRuntime(retained[index]!).callValue("probe", {})).rejects.toThrow();
      }
      expect(prepare).toHaveBeenCalledOnce();
      expect(admitted).toHaveLength(2);
      expect(admitted[1]?.operationalRunInstance).not.toBe(admitted[0]?.operationalRunInstance);
      expect(retained.map((ctx) => ctx.runId)).toEqual(
        admitted.map((context) => context.operationalRunInstance.runId),
      );
      expect(started).toHaveBeenCalledTimes(mode === "payload" ? 2 : 0);
    },
  );

  it.each(["admission", "gateway", "abort"] as const)(
    "fences %s revocation during preparation before any source effect",
    async (revocation) => {
      const entered = createDeferred();
      const release = createDeferred();
      const config: OpenClawConfig = {};
      let admitted: AdmittedRunContext | undefined;
      const controller = new AbortController();
      let gateway = {} as GatewayRequestContext;
      const execute = vi.fn(async () => jsonResult({ changed: true }));
      const tool = {
        ...probe(execute),
        prepareBeforeToolCallParams: async (args: unknown) => {
          entered.resolve();
          await release.promise;
          return args;
        },
      };
      const runtime = createCronScriptRuntime({
        config,
        prepareRuntime: prepareRuntime(config, tool),
        resolveGatewayContext: () => gateway,
        runHeadless: async ({ ctx }) => completed(await toolRuntime(ctx).callValue("probe", {})),
      });
      const result = runtime.executePayload({
        jobId: "closed-during-preparation",
        script: "return result",
        state: null,
        abortSignal: controller.signal,
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          onPostAdmission: (context) => {
            admitted = context;
          },
        },
      });
      try {
        await entered.promise;
        expect(admitted).toBeDefined();
        if (revocation === "admission") {
          closeAdmittedRunDelegatedAuthority(admitted!);
        } else if (revocation === "gateway") {
          gateway = {} as GatewayRequestContext;
        } else {
          controller.abort();
        }
        release.resolve();
        await expect(result).resolves.toMatchObject({ kind: "error" });
        expect(execute).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await result;
      }
    },
  );

  it("keeps concurrent invocations independent while sharing prepared tools", async () => {
    const config: OpenClawConfig = {};
    const entered = [createDeferred(), createDeferred()];
    const release = [createDeferred(), createDeferred()];
    const admitted: AdmittedRunContext[] = [];
    let calls = 0;
    const prepare = prepareRuntime(
      config,
      probe(async () => {
        const index = calls++;
        const before = getGatewayToolCallerIdentity()?.operationalRunInstance;
        entered[index]!.resolve();
        await release[index]!.promise;
        return jsonResult({
          owned:
            before !== undefined &&
            before === getGatewayToolCallerIdentity()?.operationalRunInstance,
        });
      }),
    );
    const runtime = createCronScriptRuntime({
      config,
      prepareRuntime: prepare,
      runHeadless: async ({ ctx }) =>
        completed({ fire: false, state: await toolRuntime(ctx).callValue("probe", {}) }),
    });
    const run = () =>
      runtime.evaluateTrigger({
        jobId: "concurrent",
        script: "return result",
        state: null,
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          onPostAdmission: (context) => admitted.push(context),
        },
      });
    const first = run();
    const second = run();
    try {
      await Promise.all(entered.map((entry) => entry.promise));
      release[0]!.resolve();
      await expect(first).resolves.toMatchObject({ kind: "evaluated", state: { owned: true } });
      expect(getAdmittedRunDelegatedAuthority(admitted[1]!)).toBeDefined();
      release[1]!.resolve();
      await expect(second).resolves.toMatchObject({ kind: "evaluated", state: { owned: true } });
      expect(prepare).toHaveBeenCalledOnce();
    } finally {
      release.forEach((entry) => entry.resolve());
      await Promise.all([first, second]);
    }
  });

  it("binds execution ownership to the payload admission after its condition closes", async () => {
    const config: OpenClawConfig = {};
    const admitted: AdmittedRunContext[] = [];
    const bind = vi.fn((context: AdmittedRunContext) => {
      expect(getAdmittedRunDelegatedAuthority(context)).toBeDefined();
    });
    const owner = createExecutionStartedOwnerBinding(bind);
    const runtime = createCronScriptRuntime({
      config,
      prepareRuntime: prepareRuntime(
        config,
        probe(async () => jsonResult({})),
      ),
      runHeadless: async () => completed({ fire: true }),
    });
    const params = {
      jobId: "condition-then-payload",
      script: "return result",
      state: null,
      executionIdentity: {
        ingress: { kind: "schedule" as const, boundary: "cron.script", state: "present" as const },
        onPostAdmission: (context: AdmittedRunContext) => {
          admitted.push(context);
          owner.onPostAdmission(context);
        },
        onExecutionStarted: owner.onExecutionStarted,
      },
    };

    await expect(runtime.evaluateTrigger(params)).resolves.toMatchObject({
      kind: "evaluated",
      fire: true,
    });
    expect(bind).not.toHaveBeenCalled();
    expect(getAdmittedRunDelegatedAuthority(admitted[0]!)).toBeUndefined();

    await expect(runtime.executePayload(params)).resolves.toMatchObject({ kind: "completed" });
    expect(bind).toHaveBeenCalledExactlyOnceWith(admitted[1]);
    expect(admitted[1]).not.toBe(admitted[0]);
    expect(getAdmittedRunDelegatedAuthority(admitted[1]!)).toBeUndefined();
  });
});
