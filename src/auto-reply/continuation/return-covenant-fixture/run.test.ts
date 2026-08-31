import { stableStringify } from "@openclaw/normalization-core";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { withTestDir } from "../../../test-helpers/temp-dir.js";
import type {
  ReturnCovenantGatewayBinding,
  ReturnCovenantGatewayControl,
  ReturnCovenantGatewayRestart,
} from "./gateway.js";
import { parseReturnCovenantPhaseRequest, sha256ReturnCovenant } from "./protocol.js";
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

class TestGateway implements ReturnCovenantGatewayControl {
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

  async stopAll(): Promise<void> {
    this.#binding = undefined;
  }

  #nextBinding(): ReturnCovenantGatewayBinding {
    this.#sequence += 1;
    return {
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

afterEach(() => {
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

describe("product return-covenant fixture run", () => {
  it("executes all typed/bracket lifecycle and authority cases over canonical stores", async () => {
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
        gateway,
        plan,
      });
      await gateway.start();
      let checkedNegativeControls = false;
      const capturedGenerations: string[] = [];
      const forbiddenCurrentGenerations: string[] = [];
      const observations: Record<string, unknown>[] = [];
      try {
        for (const casePlan of plan.cases) {
          for (const form of casePlan.forms) {
            const prepared = await run.handle(
              createReturnCovenantTestRequest({
                casePlan,
                form,
                phase: "prepare",
                plan,
              }),
              attestation,
            );
            const caseHandle = stringField(prepared, "caseHandle");

            if (!checkedNegativeControls) {
              await expect(
                run.handle(
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
                  attestation,
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
            const dispatched = await run.handle(dispatchRequest, attestation);
            const acceptance = record(dispatched.acceptance);
            const acceptanceBinding = {
              capturedAuthorityGeneration: stringField(acceptance, "capturedAuthorityGeneration"),
              heldResultId: stringField(acceptance, "heldResultId"),
              receiptId: stringField(acceptance, "receiptId"),
              resultMarker: stringField(acceptance, "resultMarker"),
            };
            capturedGenerations.push(acceptanceBinding.capturedAuthorityGeneration);

            if (!checkedNegativeControls) {
              await expect(run.handle(dispatchRequest, attestation)).rejects.toThrow(
                /expected prepared/u,
              );
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
              await expect(run.handle(wrongGeneration, attestation)).rejects.toThrow(
                /accepted dispatch/u,
              );
            }

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
            );
            const transition = record(transitioned.transition);
            const transitionBinding = {
              receiptId: stringField(transition, "receiptId"),
            };
            const released = await run.handle(
              createReturnCovenantTestRequest({
                acceptance: acceptanceBinding,
                caseHandle,
                casePlan,
                form,
                phase: "release",
                plan,
                transition: transitionBinding,
              }),
              attestation,
            );
            expect(released.release).toMatchObject({ released: true });

            if (!checkedNegativeControls) {
              const pending = await run.handle(
                createReturnCovenantTestRequest({
                  caseHandle,
                  casePlan,
                  form,
                  phase: "observe",
                  plan,
                }),
                attestation,
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
            const observed = await run.handle(
              createReturnCovenantTestRequest({
                caseHandle,
                casePlan,
                form,
                phase: "observe",
                plan,
              }),
              attestation,
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
            const cleaned = await run.handle(
              createReturnCovenantTestRequest({
                caseHandle,
                casePlan,
                form,
                phase: "cleanup",
                plan,
              }),
              attestation,
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
          run.handle(
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
            attestation,
          ),
        ).rejects.toThrow(/evidence bindings/u);
        await expect(
          run.handle(
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
            attestation,
          ),
        ).rejects.toThrow(/evidence bindings/u);
        const cleanup = await run.handle(
          createReturnCovenantTestRequest({
            casePlan: plan.cases[0]!,
            form: "typed-tool",
            phase: "cleanup-run",
            plan,
            cleanupBindings,
          }),
          attestation,
        );
        expect(cleanup.cleanupRun).toMatchObject({
          completed: true,
          ...cleanupBindings,
        });
        await run.handle(
          createReturnCovenantTestRequest({
            casePlan: plan.cases[0]!,
            form: "typed-tool",
            phase: "cleanup-run",
            plan,
            fallback: true,
          }),
          attestation,
        );
        expect(run.finalizeRequested).toBe(true);
        expect(await run.buildCleanupClaims()).toMatchObject({
          retained: {
            delegates: 0,
            queueItems: 0,
            temporarySessions: 0,
            gateways: 0,
            fixtureProcesses: 0,
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
        await gateway.stopAll();
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
        gateway,
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
          ),
        ).rejects.toThrow(/observed/u);
      } finally {
        await gateway.stopAll();
        await run.close();
      }
    });
  });
});
