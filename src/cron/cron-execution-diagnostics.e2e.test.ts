import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../agents/failover-error.js";
import type { OpenClawConfig } from "../config/config.js";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./isolated-agent/run.test-harness.js";
import { CronService, type CronEvent } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { cronStoreKey } from "./store/key.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";

vi.doUnmock("./isolated-agent/model-preflight.runtime.js");

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { resetCronModelProviderPreflightCacheForTest } =
  await import("./isolated-agent/model-preflight.runtime.js");

type ModelRef = { provider: string; model: string };

function makeCommandLaneTaskTimeoutError(lane: string, timeoutMs: number): Error {
  const error = new Error(`Command lane "${lane}" task timed out after ${timeoutMs}ms`);
  error.name = "CommandLaneTaskTimeoutError";
  return error;
}

async function listenForBrokenHttpConnections(): Promise<{
  baseUrl: string;
  server: Server;
}> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function configFor(modelRef: ModelRef, localBaseUrl?: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: `${modelRef.provider}/${modelRef.model}`,
      },
    },
    ...(localBaseUrl
      ? {
          models: {
            providers: {
              [modelRef.provider]: {
                api: "ollama",
                baseUrl: localBaseUrl,
                models: [],
              },
            },
          },
        }
      : {}),
  };
}

async function runPersistedDiagnosticCase(params: {
  cfg: OpenClawConfig;
  modelRef: ModelRef;
  name: string;
}) {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cron-execution-diagnostics-" },
    async (state) => {
      resetTaskRegistryForTests();
      const events: CronEvent[] = [];
      const storePath = state.path("cron", "jobs.json");
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onEvent: (event) => events.push(structuredClone(event)),
        runIsolatedAgentJob: async (runParams) =>
          await runCronIsolatedAgentTurn({
            ...runParams,
            cfg: params.cfg,
            deps: {},
            sessionKey: `cron:${runParams.job.id}`,
          }),
      });
      try {
        await cron.start();
        const job = await cron.add({
          name: params.name,
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: `run ${params.name}`,
            model: `${params.modelRef.provider}/${params.modelRef.model}`,
          },
          delivery: { mode: "none" },
        });
        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

        const finished = events.find(
          (event) => event.action === "finished" && event.jobId === job.id,
        );
        const history = readCronTaskRunHistoryPage({
          storeKey: cronStoreKey(storePath),
          jobId: job.id,
          limit: 1,
        }).entries[0];
        expect(finished).toBeDefined();
        expect(history).toBeDefined();
        return {
          finished: finished!,
          history: history!,
          lastError: cron.getJob(job.id)?.state.lastError,
        };
      } finally {
        cron.stop();
        resetTaskRegistryForTests({ persist: false });
      }
    },
  );
}

describe.sequential("cron execution diagnostics", () => {
  const servers: Server[] = [];

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resetCronModelProviderPreflightCacheForTest();
  });

  afterAll(async () => {
    await Promise.all(servers.map(closeServer));
  });

  it("persists and emits a real isolated-run local-provider preflight failure", async () => {
    const endpoint = await listenForBrokenHttpConnections();
    servers.push(endpoint.server);
    const modelRef = { provider: "ollama", model: "diagnostic-model" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    resolveAllowedModelRefMock.mockReturnValue({ ref: modelRef });

    const { finished, history } = await runPersistedDiagnosticCase({
      cfg: configFor(modelRef, endpoint.baseUrl),
      modelRef,
      name: "unreachable provider",
    });

    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    for (const outcome of [finished, history]) {
      expect(outcome).toMatchObject({
        status: "skipped",
        provider: "ollama",
        model: "diagnostic-model",
        error: expect.stringContaining("unavailable"),
        diagnostics: {
          entries: expect.arrayContaining([
            expect.objectContaining({
              source: "model-preflight",
              severity: "warn",
              message: expect.stringContaining("unavailable"),
            }),
          ]),
        },
      });
    }
  });

  it("persists and emits the canonical terminal timeout diagnostic", async () => {
    const modelRef = { provider: "openai", model: "gpt-5.4" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    runWithModelFallbackMock.mockRejectedValueOnce(
      makeCommandLaneTaskTimeoutError("cron-nested", 330_000),
    );

    const { finished, history } = await runPersistedDiagnosticCase({
      cfg: configFor(modelRef),
      modelRef,
      name: "nested lane timeout",
    });

    for (const outcome of [finished, history]) {
      expect(outcome).toMatchObject({
        status: "error",
        provider: "openai",
        model: "gpt-5.4",
        error: "cron: job execution timed out",
        diagnostics: {
          entries: expect.arrayContaining([
            expect.objectContaining({
              source: "cron-setup",
              severity: "error",
              message: "cron: job execution timed out",
            }),
          ]),
        },
      });
    }
  });

  it("persists provider failures without internal class names", async () => {
    const message =
      "The selected model was not found by the provider. Check the model id or choose a different model.";
    const modelRef = { provider: "openai", model: "not-a-real-model" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    resolveAllowedModelRefMock.mockReturnValue({ ref: modelRef });
    runWithModelFallbackMock.mockRejectedValueOnce(
      new FailoverError(message, {
        reason: "model_not_found",
        provider: modelRef.provider,
        model: modelRef.model,
        code: "MODEL_NOT_FOUND",
      }),
    );

    const { finished, history, lastError } = await runPersistedDiagnosticCase({
      cfg: configFor(modelRef),
      modelRef,
      name: "missing provider model",
    });

    for (const outcome of [finished, history]) {
      expect(outcome).toMatchObject({
        status: "error",
        provider: modelRef.provider,
        model: modelRef.model,
        error: `${message} | MODEL_NOT_FOUND`,
        diagnostics: { summary: message },
      });
      expect(outcome.error).not.toContain("FailoverError");
    }
    expect(lastError).toBe(`${message} | MODEL_NOT_FOUND`);
    expect(history.errorReason).toBe("model_not_found");
  });

  it("persists stale gateway lifecycle rejections instead of reporting a timeout", async () => {
    const modelRef = { provider: "openai", model: "gpt-5.4" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    runWithModelFallbackMock.mockRejectedValueOnce(createAgentRunStaleLifecycleError());

    const { finished, history, lastError } = await runPersistedDiagnosticCase({
      cfg: configFor(modelRef),
      modelRef,
      name: "stale gateway lifecycle",
    });
    const expected = "Agent run belongs to a stale gateway lifecycle | ERR_STALE_GATEWAY_LIFECYCLE";

    for (const outcome of [finished, history]) {
      expect(outcome).toMatchObject({
        status: "error",
        error: expected,
      });
      expect(outcome.error).not.toContain("timed out");
    }
    expect(lastError).toBe(expected);
  });

  it("persists and emits a fatal execution-denial diagnostic", async () => {
    const modelRef = { provider: "openai", model: "gpt-5.4" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        agentMeta: {},
        failureSignal: {
          kind: "execution_denied",
          source: "tool",
          toolName: "exec",
          code: "SYSTEM_RUN_DENIED",
          message: "SYSTEM_RUN_DENIED: approval required",
          fatalForCron: true,
        },
      },
    });

    const { finished, history } = await runPersistedDiagnosticCase({
      cfg: configFor(modelRef),
      modelRef,
      name: "execution denied",
    });

    for (const outcome of [finished, history]) {
      expect(outcome).toMatchObject({
        status: "error",
        provider: "openai",
        model: "gpt-5.4",
        error: "SYSTEM_RUN_DENIED: approval required",
        summary: "SYSTEM_RUN_DENIED: approval required",
        diagnostics: {
          entries: expect.arrayContaining([
            expect.objectContaining({
              source: "tool",
              severity: "error",
              message: "SYSTEM_RUN_DENIED: approval required",
            }),
          ]),
        },
      });
    }
  });
});
