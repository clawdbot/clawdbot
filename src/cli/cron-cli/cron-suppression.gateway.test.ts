// Boundary proof: real silent dispatch, service persistence, Gateway handlers, and CLI rendering.
// The agent-output input and RPC transport are test boundaries; no provider or channel send is claimed.
import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveCronDeliveryPlan } from "../../cron/delivery-plan.js";
import { dispatchCronDelivery } from "../../cron/isolated-agent/delivery-dispatch.js";
import { CronService, type CronEvent } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronServiceDeps } from "../../cron/service/state.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { readCronTaskRunHistoryPage } from "../../cron/task-run-history.js";
import type { CronJob } from "../../cron/types.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import type { RespondFn } from "../../gateway/server-methods/types.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { ExitError } from "../../runtime.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
  callGatewayFromCli: vi.fn(),
}));

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return { ...actual, callGatewayFromCli: mocks.callGatewayFromCli };
});
vi.mock("../../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js");
  return { ...actual, defaultRuntime: mocks.runtime };
});

const { registerCronCli } = await import("../cron-cli.js");

async function runCli(args: string[]) {
  for (const mock of Object.values(mocks.runtime)) {
    mock.mockClear();
  }
  const program = new Command();
  program.exitOverride();
  registerCronCli(program);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["cron", ...args], { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    exitCode = error.code;
  }
  expect(mocks.runtime.error).not.toHaveBeenCalled();
  return {
    text: mocks.runtime.log.mock.calls.map(([line]) => String(line)).join("\n"),
    json: mocks.runtime.writeJson.mock.calls.at(-1)?.[0],
    exitCode,
  };
}

function installGatewayTransport(cron: CronService, storePath: string) {
  const invoke = async (method: string, params: Record<string, unknown> = {}) => {
    const handler = expectDefined(cronHandlers[method], `missing Gateway method ${method}`);
    let response: { ok: boolean; payload?: unknown; error?: { message?: string } } | undefined;
    const respond: RespondFn = (ok, payload, error) => {
      response = { ok, payload, error };
    };
    await handler({
      req: {} as never,
      client: null,
      params,
      respond,
      context: { cron, cronStorePath: storePath, getRuntimeConfig: () => ({}) } as never,
    } as never);
    const result = expectDefined(response, `${method} returned no response`);
    expect(result.ok, result.error?.message).toBe(true);
    // JSON wire encoding drops undefined fields; structuredClone would preserve them.
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    return JSON.parse(JSON.stringify(result.payload)) as unknown;
  };
  mocks.callGatewayFromCli.mockImplementation(
    async (method: string, _options: unknown, params?: Record<string, unknown>) =>
      invoke(method, params),
  );
  return invoke;
}

afterEach(() => {
  mocks.callGatewayFromCli.mockReset();
  vi.restoreAllMocks();
});

describe("cron CLI delivery suppression readback", () => {
  it("distinguishes intentional silence from failures across repeated runs of one stored job", async () => {
    await withOpenClawTestState(
      { layout: "home", prefix: "openclaw-cron-cli-suppression-" },
      async (state) => {
        await state.writeConfig({});
        resetTaskRegistryForTests({ persist: false });
        const storePath = state.statePath("cron", "jobs.json");
        const events: CronEvent[] = [];
        let phase:
          | "silent"
          | "delivery-error"
          | "required-delivery-error"
          | "execution-error"
          | "not-requested" = "silent";
        const runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"] = async ({
          job,
          abortSignal,
        }) => {
          if (phase === "execution-error") {
            throw new Error("fixture agent execution failed");
          }
          const text = phase === "silent" ? "NO_REPLY" : "Actionable update";
          const sessionId = randomUUID();
          const sessionKey = `agent:main:cron:${job.id}:run:${sessionId}`;
          const now = Date.now();
          const dispatch = await dispatchCronDelivery({
            cfg: {},
            cfgWithAgentDefaults: {},
            deps: {},
            job,
            agentId: "main",
            agentSessionKey: sessionKey,
            runSessionKey: sessionKey,
            sessionId,
            lifecycleRevision: randomUUID(),
            sessionUpdatedAt: now,
            runStartedAt: now,
            runEndedAt: now,
            timeoutMs: 5_000,
            resolvedDelivery:
              phase === "delivery-error" || phase === "required-delivery-error"
                ? {
                    ok: false,
                    mode: "explicit",
                    error: new Error("fixture delivery route unavailable"),
                  }
                : { ok: true, mode: "explicit", channel: "telegram", to: "123" },
            deliveryPlan: resolveCronDeliveryPlan(job),
            deliveryRequested: phase !== "not-requested",
            undeliveredRunStatus: "ok",
            spawnOnlyHandoff: false,
            sourceDeliveryOutcome: {
              visibleDeliveries: [],
              verifiedMessageToolDelivery: false,
              satisfiesSourceDelivery: false,
              unverifiedMessageToolDelivery: false,
            },
            deliveryBestEffort: job.delivery?.bestEffort === true,
            deliveryPayloadHasStructuredContent: false,
            deliveryPayloads: [{ text }],
            synthesizedText: text,
            summary: text,
            outputText: text,
            abortSignal,
            isAborted: () => abortSignal?.aborted === true,
            abortReason: () => "fixture aborted",
            withRunSession: (result) => ({ ...result, sessionId, sessionKey }),
          });
          return {
            status: "ok",
            ...dispatch.result,
            delivered: dispatch.delivered,
            deliveryAttempted: dispatch.deliveryAttempted,
            deliveryError: dispatch.deliveryError,
            deliverySuppressionReason: dispatch.deliverySuppressionReason,
            deliveryState: dispatch.deliveryState,
          };
        };
        const cron = new CronService({
          storePath,
          defaultAgentId: "main",
          cronEnabled: true,
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob,
          onEvent: (event) => {
            if (event.action === "finished") {
              events.push(event);
            }
          },
        });
        const invoke = installGatewayTransport(cron, storePath);
        try {
          await cron.start();
          const job = await cron.add({
            name: "idle-check",
            enabled: true,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "Check for work; reply NO_REPLY when idle." },
            delivery: { mode: "announce", channel: "telegram", to: "123" },
          });
          for (const nextPhase of [
            "silent",
            "delivery-error",
            "required-delivery-error",
            "execution-error",
            "silent",
            "not-requested",
          ] as const) {
            phase = nextPhase;
            await cron.update(job.id, {
              delivery:
                phase === "not-requested"
                  ? { mode: "none" }
                  : {
                      mode: "announce",
                      channel: "telegram",
                      to: "123",
                      bestEffort: phase === "delivery-error",
                    },
            });
            const run = await runCli([
              "run",
              job.id,
              "--wait",
              "--wait-timeout",
              "10s",
              "--poll-interval",
              "10ms",
            ]);
            const failed = phase === "execution-error" || phase === "required-delivery-error";
            const expectedStatus = failed ? "error" : "ok";
            const completionStatus = failed ? "failed" : "succeeded";
            const deliveryStatus =
              phase === "execution-error"
                ? "unknown"
                : phase === "not-requested"
                  ? "not-requested"
                  : "not-delivered";
            const delivered = phase === "execution-error" ? undefined : false;
            expect(run.exitCode).toBe(failed ? 1 : 0);
            await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

            const reason = phase === "silent" ? "silent" : undefined;
            const persisted = expectDefined(
              (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id),
              "expected persisted cron job",
            );
            expect(persisted.state.deliverySuppressionReason).toBe(reason);
            expect(persisted.state).toMatchObject({
              lastRunStatus: expectedStatus,
              lastDeliveryStatus: deliveryStatus,
            });
            expect(persisted.state.lastDelivered).toBe(delivered);
            const history = readCronTaskRunHistoryPage({
              storeKey: cronStoreKey(storePath),
              jobId: job.id,
            });
            expect(history.entries[0]?.deliverySuppressionReason).toBe(reason);
            const outcome = { status: expectedStatus, completionStatus, deliveryStatus };
            expect(history.entries[0]).toMatchObject(outcome);
            expect(history.entries[0]?.delivered).toBe(delivered);
            expect(run.json).toMatchObject({
              completed: true,
              status: expectedStatus,
              completionStatus,
              run: outcome,
            });
            if (phase === "silent" || phase === "not-requested") {
              expect(persisted.state.lastError).toBeUndefined();
              expect(persisted.state.lastDeliveryError).toBeUndefined();
              expect(history.entries[0]?.deliveryError).toBeUndefined();
            } else {
              expect(persisted.state.lastDeliveryError).toContain(
                phase === "execution-error"
                  ? "fixture agent execution failed"
                  : "fixture delivery route unavailable",
              );
            }
            expect(events.at(-1)?.deliverySuppressionReason).toBe(reason);
            expect(
              (run.json as { run: { deliverySuppressionReason?: string } }).run
                .deliverySuppressionReason,
            ).toBe(reason);
            const get = (await runCli(["get", job.id])).json as CronJob & {
              deliverySuppressionReason?: string;
            };
            expect(get.deliverySuppressionReason).toBe(reason);
            expect(get.state.deliverySuppressionReason).toBe(reason);
            const compact = (await invoke("cron.list", { compact: true })) as {
              jobs: Array<{ deliverySuppressionReason?: string }>;
            };
            expect(compact.jobs[0]?.deliverySuppressionReason).toBe(reason);
            const listJson = (await runCli(["list", "--json"])).json as { jobs: CronJob[] };
            expect(listJson.jobs[0]?.state.deliverySuppressionReason).toBe(reason);
            const list = await runCli(["list"]);
            const show = await runCli(["show", job.id]);
            if (isRich()) {
              const color = failed
                ? theme.error
                : phase === "delivery-error"
                  ? theme.warn
                  : theme.success;
              const probe = color("probe");
              const expectedAnsi = probe.slice(0, probe.indexOf("probe"));
              expect(expectedAnsi).not.toBe("");
              expect.soft(list.text).toContain(`${expectedAnsi}${expectedStatus}`);
            }
            if (phase === "silent") {
              expect.soft(list.text).toMatch(/silent|suppressed/i);
              expect.soft(show.text).toMatch(/silent|suppressed/i);
              expect.soft(list.text).not.toContain("ok (not delivered)");
              expect.soft(show.text).not.toContain("ok (not delivered)");
            } else if (phase === "delivery-error") {
              expect(list.text).toContain("ok (not delivered)");
              expect(show.text).toContain(
                "last delivery error: fixture delivery route unavailable",
              );
            } else if (failed) {
              expect(show.text).toContain("status: error");
              expect(show.text).not.toContain("ok (not delivered)");
            } else {
              expect(show.text).toContain("status: ok");
              expect(show.text).not.toContain("ok (not delivered)");
            }
          }
          expect(events).toHaveLength(6);
          expect(
            readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId: job.id }).total,
          ).toBe(6);
        } finally {
          cron.stop();
          resetTaskRegistryForTests({ persist: false });
        }
      },
    );
  }, 30_000);
});
