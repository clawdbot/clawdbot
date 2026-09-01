import { stableStringify } from "@openclaw/normalization-core";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { appendTranscriptMessage } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../../../infra/node-sqlite.js";
import { removeSystemEvents } from "../../../infra/system-events.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.message.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withTestDir } from "../../../test-helpers/temp-dir.js";
import { returnCovenantCaseScope } from "./case-setup.js";
import {
  returnCovenantCurrentSessionId,
  type ReturnCovenantCaseState,
  type ReturnCovenantFixtureContext,
} from "./case-state.js";
import type {
  ReturnCovenantGatewayBinding,
  ReturnCovenantGatewayRestart,
} from "./gateway-generation.js";
import { parseReturnCovenantPhaseRequest, sha256ReturnCovenant } from "./protocol.js";
import { buildReturnCovenantRetentionRequest } from "./retention.js";
import { ReturnCovenantFixtureRun } from "./run.js";
import {
  createReturnCovenantTestAttestation,
  createReturnCovenantTestPlan,
  createReturnCovenantTestRequest,
} from "./test-plan.test-support.js";

class TestClock {
  #monotonic = 0;
  #wall = Date.parse("2026-08-31T12:00:00.000Z");

  advance(milliseconds: number): void {
    this.#monotonic += milliseconds;
    this.#wall += milliseconds;
  }

  monotonicNow(): number {
    return this.#monotonic;
  }

  wallNow(): number {
    const now = this.#wall;
    this.#wall += 1;
    return now;
  }
}

class TestGateway {
  #binding: ReturnCovenantGatewayBinding | undefined;
  #sequence = 0;
  restarts = 0;

  current(): ReturnCovenantGatewayBinding {
    if (!this.#binding) {
      throw new Error("test gateway is not running");
    }
    return this.#binding;
  }

  async start(): Promise<ReturnCovenantGatewayBinding> {
    this.#binding = this.#nextBinding();
    return this.#binding;
  }

  async restart(): Promise<ReturnCovenantGatewayRestart> {
    const original = this.current();
    this.#binding = this.#nextBinding();
    this.restarts += 1;
    return { original, replacement: this.#binding };
  }

  #nextBinding(): ReturnCovenantGatewayBinding {
    this.#sequence += 1;
    return {
      bootId: `gateway-${this.#sequence}`,
      endpoint: `http://127.0.0.1:${19_000 + this.#sequence}`,
      pid: 100 + this.#sequence,
      startFingerprint: this.#sequence.toString(16).padStart(64, "0"),
    };
  }
}

const config: OpenClawConfig = {
  gateway: { mode: "local" },
  agents: {
    defaults: {
      continuation: {
        enabled: true,
        crossSessionTargeting: "disabled",
      },
    },
  },
  session: { mainKey: "main", scope: "per-sender" },
};

function record(value: unknown): Record<string, unknown> {
  return asNonArrayRecord(value);
}

function stringField(value: unknown, field: string): string {
  const fieldValue = record(value)[field];
  if (typeof fieldValue !== "string") {
    throw new Error(`expected string field ${field}`);
  }
  return fieldValue;
}

function gatewayBinding(sequence: number): ReturnCovenantGatewayBinding {
  return {
    bootId: `gateway-${sequence}`,
    endpoint: `http://127.0.0.1:${19_000 + sequence}`,
    pid: 100 + sequence,
    startFingerprint: sequence.toString(16).padStart(64, "0"),
  };
}

afterEach(() => {
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

describe("product return-covenant fixture run", () => {
  it("executes all typed/bracket lifecycle and authority cases over canonical stores", async () => {
    await withTestDir({ prefix: "openclaw-return-covenant-driver-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      setRuntimeConfigSnapshot(config);
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      openOpenClawAgentDatabase({ agentId: "main", env });
      const plan = createReturnCovenantTestPlan();
      const attestation = createReturnCovenantTestAttestation(plan);
      const clock = new TestClock();
      const gateway = new TestGateway();
      let run = await ReturnCovenantFixtureRun.create({ clock, config, env, plan });
      await gateway.start();
      const invoke = (
        request: ReturnType<typeof createReturnCovenantTestRequest>,
        restart?: ReturnCovenantGatewayRestart,
      ) =>
        run.handle(request, attestation, {
          gateway: gateway.current(),
          ...(restart ? { restart } : {}),
        });
      let checkedNegativeControls = false;
      const capturedGenerations: string[] = [];
      const forbiddenCurrentGenerations: string[] = [];
      const observations: Record<string, unknown>[] = [];
      const caseForms: Parameters<typeof buildReturnCovenantRetentionRequest>[0]["caseForms"] = [];
      try {
        for (const casePlan of plan.cases) {
          for (const form of casePlan.forms) {
            const prepared = await invoke(
              createReturnCovenantTestRequest({
                casePlan,
                form,
                phase: "prepare",
                plan,
              }),
            );
            const caseHandle = stringField(prepared, "caseHandle");
            caseForms.push({ caseId: casePlan.id, form, caseHandle });
            if (!checkedNegativeControls) {
              await expect(
                invoke(
                  createReturnCovenantTestRequest({
                    casePlan,
                    form,
                    phase: "cleanup-run",
                    plan,
                    cleanupBindings: {
                      observationSetSha256: "4".repeat(64),
                      phaseChainSha256: "5".repeat(64),
                      driverAttestationSha256: attestation.attestationSha256,
                    },
                  }),
                ),
              ).rejects.toThrow(/every planned case\/form handle/u);
            }
            const dispatchRequest = createReturnCovenantTestRequest({
              caseHandle,
              casePlan,
              form,
              phase: "dispatch",
              plan,
            });
            const dispatched = await invoke(dispatchRequest);
            const acceptance = record(dispatched.acceptance);
            const acceptanceBinding = {
              capturedAuthorityGeneration: stringField(acceptance, "capturedAuthorityGeneration"),
              heldResultId: stringField(acceptance, "heldResultId"),
              receiptId: stringField(acceptance, "receiptId"),
              resultMarker: stringField(acceptance, "resultMarker"),
            };
            capturedGenerations.push(acceptanceBinding.capturedAuthorityGeneration);
            if (!checkedNegativeControls) {
              await expect(invoke(dispatchRequest)).rejects.toThrow(/expected prepared/u);
              const validTransition = createReturnCovenantTestRequest({
                acceptance: acceptanceBinding,
                caseHandle,
                casePlan,
                form,
                phase: "transition",
                plan,
              });
              const wrongGeneration = parseReturnCovenantPhaseRequest({
                ...validTransition,
                capturedAuthorityGeneration: "99999999-9999-4999-8999-999999999999",
              });
              await expect(invoke(wrongGeneration)).rejects.toThrow(/accepted dispatch/u);
            }

            let restart: ReturnCovenantGatewayRestart | undefined;
            if (casePlan.restartBetweenAcceptanceAndRelease) {
              const snapshot = await run.snapshotForGatewayRestart();
              restart = await gateway.restart();
              run = await ReturnCovenantFixtureRun.restore({
                clock,
                config,
                env,
                plan,
                snapshot,
              });
            }
            const transitioned = await invoke(
              createReturnCovenantTestRequest({
                acceptance: acceptanceBinding,
                caseHandle,
                casePlan,
                form,
                phase: "transition",
                plan,
              }),
              restart,
            );
            const transition = record(transitioned.transition);
            const transitionBinding = {
              receiptId: stringField(transition, "receiptId"),
            };
            const released = await invoke(
              createReturnCovenantTestRequest({
                acceptance: acceptanceBinding,
                caseHandle,
                casePlan,
                form,
                phase: "release",
                plan,
                transition: transitionBinding,
              }),
            );
            expect(released.release).toMatchObject({ released: true });

            if (!checkedNegativeControls) {
              const pending = await invoke(
                createReturnCovenantTestRequest({
                  caseHandle,
                  casePlan,
                  form,
                  phase: "observe",
                  plan,
                }),
              );
              expect(pending).toEqual({
                settled: false,
                observation: null,
              });
            }
            clock.advance(plan.settlementWindowMs);
            if (casePlan.expectedEffects[form].wakes === 1) {
              await vi.waitFor(
                () => {
                  expect(run.readWakeCount(casePlan.id, form)).toBe(1);
                },
                { interval: 10, timeout: 1000 },
              );
            }
            const observed = await invoke(
              createReturnCovenantTestRequest({
                caseHandle,
                casePlan,
                form,
                phase: "observe",
                plan,
              }),
            );
            const observation = record(observed.observation);
            observations.push(observation);
            expect(observation.effects).toMatchObject({
              observed: casePlan.expectedEffects[form],
            });
            expect(observation.lifecycle).toMatchObject({
              generationAdvanced: casePlan.kind === "forbidden",
              effectiveAuthorityUnchanged: casePlan.kind === "allowed",
            });
            if (casePlan.kind === "forbidden") {
              forbiddenCurrentGenerations.push(
                stringField(observation.authorityDiagnostic, "currentAuthorityGeneration"),
              );
            }
            expect(observation.scans).toMatchObject({
              successorTranscript: { matches: 0 },
              trustedSystemEvents: { matches: 0 },
            });
            expect(observation.delivery).toMatchObject({
              queue: {
                acknowledged: true,
                removed: true,
                retryScheduled: false,
              },
            });
            const cleaned = await invoke(
              createReturnCovenantTestRequest({
                caseHandle,
                casePlan,
                form,
                phase: "cleanup",
                plan,
              }),
            );
            expect(cleaned.cleanup).toMatchObject({ closed: true });
            checkedNegativeControls = true;
          }
        }

        const cleanupBindings = {
          observationSetSha256: sha256ReturnCovenant(stableStringify(observations)),
          phaseChainSha256: "5".repeat(64),
          driverAttestationSha256: attestation.attestationSha256,
        };
        await expect(
          invoke(
            createReturnCovenantTestRequest({
              casePlan: plan.cases[0]!,
              form: "typed-tool",
              phase: "cleanup-run",
              plan,
              cleanupBindings: {
                ...cleanupBindings,
                observationSetSha256: "4".repeat(64),
              },
            }),
          ),
        ).rejects.toThrow(/evidence bindings/u);
        await expect(
          invoke(
            createReturnCovenantTestRequest({
              casePlan: plan.cases[0]!,
              form: "typed-tool",
              phase: "cleanup-run",
              plan,
              cleanupBindings: {
                ...cleanupBindings,
                driverAttestationSha256: "7".repeat(64),
              },
            }),
          ),
        ).rejects.toThrow(/evidence bindings/u);
        const cleanup = await invoke(
          createReturnCovenantTestRequest({
            casePlan: plan.cases[0]!,
            form: "typed-tool",
            phase: "cleanup-run",
            plan,
            cleanupBindings,
          }),
        );
        expect(cleanup.cleanupRun).toMatchObject({
          completed: true,
          ...cleanupBindings,
        });
        const cleanupRun = record(cleanup.cleanupRun);
        const retentionRequest = buildReturnCovenantRetentionRequest({
          caseForms,
          cleanupRun: {
            receiptId: stringField(cleanupRun, "receiptId"),
            observationSetSha256: stringField(cleanupRun, "observationSetSha256"),
            phaseChainSha256: stringField(cleanupRun, "phaseChainSha256"),
            driverAttestationSha256: stringField(cleanupRun, "driverAttestationSha256"),
          },
          plan,
          requestNonce: sha256ReturnCovenant("return-covenant-test-retention-request"),
        });
        await expect(
          run.inspectRetention(
            {
              ...retentionRequest,
              candidateSha: "8".repeat(40),
            },
            gateway.current(),
          ),
        ).rejects.toThrow(/identity mismatch/u);
        await expect(
          run.inspectRetention(retentionRequest, gateway.current()),
        ).resolves.toMatchObject({
          schema: "openclaw.k6.return-covenant-retention-response.v1",
          requestNonce: retentionRequest.requestNonce,
          gateway: {
            endpoint: gateway.current().endpoint,
            namespacePid: gateway.current().pid,
            namespaceStartFingerprint: gateway.current().startFingerprint,
          },
          resources: {
            delegates: { complete: true, total: 0, nextCursor: null, items: [] },
            queueItems: { complete: true, total: 0, nextCursor: null, items: [] },
            temporarySessions: { complete: true, total: 0, nextCursor: null, items: [] },
          },
        });
        await expect(run.inspectRetention(retentionRequest, gateway.current())).rejects.toThrow(
          /already consumed/u,
        );
        await invoke(
          createReturnCovenantTestRequest({
            casePlan: plan.cases[0]!,
            form: "typed-tool",
            phase: "cleanup-run",
            plan,
            fallback: true,
          }),
        );
        expect(run.finalizeRequested).toBe(true);
        expect(await run.buildCleanupClaims()).toMatchObject({
          retained: {
            delegates: 0,
            queueItems: 0,
            temporarySessions: 0,
          },
          allCaseHandlesClosed: true,
          caseHandles: expect.arrayContaining([expect.stringMatching(/^case-[0-9a-f]{40}$/u)]),
        });
        expect(new Set(capturedGenerations).size).toBe(24);
        expect(new Set([...capturedGenerations, ...forbiddenCurrentGenerations]).size).toBe(
          capturedGenerations.length + forbiddenCurrentGenerations.length,
        );
        expect(gateway.restarts).toBe(2);
      } finally {
        await run.close();
      }
    });
  });

  it("refuses normal cleanup before a settled observation", async () => {
    await withTestDir({ prefix: "openclaw-return-covenant-driver-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      setRuntimeConfigSnapshot(config);
      const plan = createReturnCovenantTestPlan();
      const attestation = createReturnCovenantTestAttestation(plan);
      const gateway = new TestGateway();
      const run = await ReturnCovenantFixtureRun.create({
        config,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        plan,
      });
      await gateway.start();
      try {
        const casePlan = plan.cases[0]!;
        const prepared = await run.handle(
          createReturnCovenantTestRequest({
            casePlan,
            form: "typed-tool",
            phase: "prepare",
            plan,
          }),
          attestation,
          { gateway: gateway.current() },
        );
        await expect(
          run.handle(
            createReturnCovenantTestRequest({
              caseHandle: stringField(prepared, "caseHandle"),
              casePlan,
              form: "typed-tool",
              phase: "cleanup",
              plan,
            }),
            attestation,
            { gateway: gateway.current() },
          ),
        ).rejects.toThrow(/observed/u);
      } finally {
        await run.close();
      }
    });
  });

  it("rejects a phase from a replaced gateway generation", async () => {
    await withTestDir({ prefix: "openclaw-return-covenant-driver-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      setRuntimeConfigSnapshot(config);
      const plan = createReturnCovenantTestPlan();
      const attestation = createReturnCovenantTestAttestation(plan);
      const gateway = new TestGateway();
      const run = await ReturnCovenantFixtureRun.create({
        config,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        plan,
      });
      await gateway.start();
      try {
        const casePlan = plan.cases[0]!;
        const prepared = await run.handle(
          createReturnCovenantTestRequest({
            casePlan,
            form: "typed-tool",
            phase: "prepare",
            plan,
          }),
          attestation,
          { gateway: gatewayBinding(1) },
        );
        await expect(
          run.handle(
            createReturnCovenantTestRequest({
              caseHandle: stringField(prepared, "caseHandle"),
              casePlan,
              form: "typed-tool",
              phase: "dispatch",
              plan,
            }),
            attestation,
            { gateway: gatewayBinding(2) },
          ),
        ).rejects.toThrow(/gateway generation/u);
      } finally {
        await run.close();
      }
    });
  });

  it("executes the first case operation against its migrated profile store", async () => {
    await withTestDir({ prefix: "openclaw-return-covenant-driver-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      setRuntimeConfigSnapshot(config);
      const plan = createReturnCovenantTestPlan();
      const attestation = createReturnCovenantTestAttestation(plan);
      const gateway = new TestGateway();
      let faultDatabase: ReturnType<typeof openNodeSqliteDatabase> | undefined;
      const run = await ReturnCovenantFixtureRun.create({
        config,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        faults: {
          afterProfileActivated: ({ databasePath }: { databasePath: string }) => {
            faultDatabase = openNodeSqliteDatabase(databasePath);
            faultDatabase.exec("BEGIN IMMEDIATE");
          },
        },
        plan,
      });
      await gateway.start();
      try {
        await expect(
          run.handle(
            createReturnCovenantTestRequest({
              casePlan: plan.cases[0]!,
              form: "typed-tool",
              phase: "prepare",
              plan,
            }),
            attestation,
            { gateway: gatewayBinding(1) },
          ),
        ).rejects.toThrow(/busy|locked/u);
      } finally {
        faultDatabase?.close();
        await run.close();
      }
    });
  });

  it.each(["drop", "duplicate", "cross-case-leak"] as const)(
    "rejects %s of the exact durable result marker",
    async (fault) => {
      await withTestDir({ prefix: "openclaw-return-covenant-driver-" }, async (stateDir) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        setRuntimeConfigSnapshot(config);
        const plan = createReturnCovenantTestPlan();
        const attestation = createReturnCovenantTestAttestation(plan);
        const clock = new TestClock();
        const gateway = new TestGateway();
        const run = await ReturnCovenantFixtureRun.create({
          clock,
          config,
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          faults: {
            beforeObserve: async (params: {
              context: ReturnCovenantFixtureContext;
              state: ReturnCovenantCaseState;
            }) => {
              if (fault === "drop") {
                removeSystemEvents(params.state.casePlan.logicalSessionKey, () => true);
                return;
              }
              const text =
                fault === "duplicate"
                  ? params.state.resultText
                  : `[Internal task completion event] leaked RCV-${"f".repeat(32)}.`;
              await appendTranscriptMessage(
                {
                  ...returnCovenantCaseScope(params.state, params.context),
                  sessionId: returnCovenantCurrentSessionId(params.state),
                },
                {
                  message: buildPersistedUserTurnMessage({
                    text,
                    timestamp: params.context.clock.wallNow(),
                  }),
                },
              );
            },
          },
          plan,
        });
        await gateway.start();
        try {
          const casePlan = plan.cases[0]!;
          const form = "typed-tool";
          const binding = gatewayBinding(1);
          const prepared = await run.handle(
            createReturnCovenantTestRequest({
              casePlan,
              form,
              phase: "prepare",
              plan,
            }),
            attestation,
            { gateway: binding },
          );
          const caseHandle = stringField(prepared, "caseHandle");
          const dispatched = await run.handle(
            createReturnCovenantTestRequest({
              caseHandle,
              casePlan,
              form,
              phase: "dispatch",
              plan,
            }),
            attestation,
            { gateway: binding },
          );
          const acceptance = record(dispatched.acceptance);
          const acceptanceBinding = {
            capturedAuthorityGeneration: stringField(acceptance, "capturedAuthorityGeneration"),
            heldResultId: stringField(acceptance, "heldResultId"),
            receiptId: stringField(acceptance, "receiptId"),
            resultMarker: stringField(acceptance, "resultMarker"),
          };
          const transitioned = await run.handle(
            createReturnCovenantTestRequest({
              acceptance: acceptanceBinding,
              caseHandle,
              casePlan,
              form,
              phase: "transition",
              plan,
            }),
            attestation,
            { gateway: binding },
          );
          await run.handle(
            createReturnCovenantTestRequest({
              acceptance: acceptanceBinding,
              caseHandle,
              casePlan,
              form,
              phase: "release",
              plan,
              transition: { receiptId: stringField(transitioned.transition, "receiptId") },
            }),
            attestation,
            { gateway: binding },
          );
          clock.advance(plan.settlementWindowMs);
          await expect(
            run.handle(
              createReturnCovenantTestRequest({
                caseHandle,
                casePlan,
                form,
                phase: "observe",
                plan,
              }),
              attestation,
              { gateway: binding },
            ),
          ).rejects.toThrow(
            fault === "cross-case-leak" ? /foreign result marker/u : /durable result marker/u,
          );
        } finally {
          await run.close();
        }
      });
    },
  );
});
