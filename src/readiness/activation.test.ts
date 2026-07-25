import { describe, expect, it, vi } from "vitest";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CONFIG_CURRENT_CRITERION_ID,
  MODEL_ROUTE_READY_CRITERION_ID,
  SECRETS_READY_CRITERION_ID,
  buildConfigCurrentCondition,
  buildModelRouteReadyCondition,
  buildSecretsReadyCondition,
  createActivationReadinessResolver,
  isReadinessCriterionSelected,
} from "./activation.js";
import type { ReadinessCondition } from "./conditions.js";

function condition(type: string): ReadinessCondition {
  return {
    type,
    status: "True",
    requirement: "advisory",
    reason: `${type}Ready`,
    message: `${type} is ready.`,
  };
}

describe("activation readiness", () => {
  it("detects required and advisory criterion selection", () => {
    expect(
      isReadinessCriterionSelected(
        { gateway: { readiness: { advisoryCriteria: [MODEL_ROUTE_READY_CRITERION_ID] } } },
        MODEL_ROUTE_READY_CRITERION_ID,
      ),
    ).toBe(true);
    expect(
      isReadinessCriterionSelected(
        { gateway: { readiness: { requiredCriteria: [MODEL_ROUTE_READY_CRITERION_ID] } } },
        MODEL_ROUTE_READY_CRITERION_ID,
      ),
    ).toBe(true);
    expect(isReadinessCriterionSelected({}, MODEL_ROUTE_READY_CRITERION_ID)).toBe(false);
  });

  it("evaluates only selected activation criteria", () => {
    const deps = {
      configCurrent: vi.fn(() => condition("ConfigCurrent")),
      modelRouteReady: vi.fn(() => condition("ModelRouteReady")),
      secretsReady: vi.fn(() => condition("SecretsReady")),
    };
    const resolve = createActivationReadinessResolver(deps);

    expect(resolve({ config: {}, criterionIds: new Set([SECRETS_READY_CRITERION_ID]) })).toEqual(
      new Map([[SECRETS_READY_CRITERION_ID, condition("SecretsReady")]]),
    );
    expect(deps.secretsReady).toHaveBeenCalledOnce();
    expect(deps.configCurrent).not.toHaveBeenCalled();
    expect(deps.modelRouteReady).not.toHaveBeenCalled();
  });

  it("converts owner inspection errors to a bounded unknown condition", () => {
    const resolve = createActivationReadinessResolver({
      configCurrent: () => {
        throw new Error("private runtime details");
      },
      modelRouteReady: () => condition("ModelRouteReady"),
      secretsReady: () => condition("SecretsReady"),
    });

    expect(
      resolve({ config: {}, criterionIds: new Set([CONFIG_CURRENT_CRITERION_ID]) }).get(
        CONFIG_CURRENT_CRITERION_ID,
      ),
    ).toEqual({
      type: "ConfigCurrent",
      subjectRef: "openclaw/config/active",
      status: "Unknown",
      requirement: "advisory",
      reason: "CriterionEvaluationFailed",
      message: "The readiness criterion could not inspect its runtime snapshot.",
    });
  });

  it("compares the active and source config generations", () => {
    const metadata = {
      revision: 2,
      fingerprint: "runtime",
      sourceFingerprint: "source",
      updatedAtMs: 1,
    };

    expect(buildConfigCurrentCondition(metadata, "source")).toMatchObject({
      status: "True",
      reason: "ConfigCurrent",
    });
    expect(buildConfigCurrentCondition(metadata, "previous")).toMatchObject({
      status: "False",
      reason: "ConfigRestartRequired",
    });
    expect(buildConfigCurrentCondition(null, null)).toMatchObject({
      status: "Unknown",
      reason: "ConfigGenerationUnavailable",
    });
  });

  it("summarizes degraded secret owners without owner identities", () => {
    const result = buildSecretsReadyCondition([
      {
        ownerKind: "provider",
        ownerId: "private-provider-id",
        state: "unavailable",
        paths: ["private.path"],
        refKeys: ["private-ref"],
        reason: "private failure",
      },
    ]);

    expect(result).toMatchObject({ status: "False", reason: "SecretOwnersUnavailable" });
    expect(result.message).toContain("provider");
    expect(result.message).not.toContain("private");
  });

  it("recognizes every activation criterion id", () => {
    const resolve = createActivationReadinessResolver({
      configCurrent: () => condition("ConfigCurrent"),
      modelRouteReady: () => condition("ModelRouteReady"),
      secretsReady: () => condition("SecretsReady"),
    });
    const result = resolve({
      config: {},
      criterionIds: new Set([
        CONFIG_CURRENT_CRITERION_ID,
        MODEL_ROUTE_READY_CRITERION_ID,
        SECRETS_READY_CRITERION_ID,
      ]),
    });

    expect([...result.keys()]).toEqual([
      CONFIG_CURRENT_CRITERION_ID,
      MODEL_ROUTE_READY_CRITERION_ID,
      SECRETS_READY_CRITERION_ID,
    ]);
  });

  it("reads the configured model owner without changing its lifecycle mode", () => {
    const captured: unknown[] = [];
    const config: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };

    expect(
      buildModelRouteReadyCondition(
        config,
        {},
        {
          listOwners: () => [{ agentId: "main", agentDir: "/agent", config }],
          getSnapshot: (input) => {
            captured.push(input);
            return undefined;
          },
          getProviderAuthStates: () => null,
        },
      ),
    ).toMatchObject({ status: "Unknown", reason: "ModelRuntimeSnapshotUnavailable" });
    expect(captured).toEqual([expect.not.objectContaining({ readOnly: expect.anything() })]);
  });

  it.each([
    [true, "True", "ModelRouteReady"],
    [false, "False", "ModelAuthUnavailable"],
  ] as const)("uses published provider auth evidence (%s)", (available, status, reason) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "anthropic/claude-test" } },
        list: [{ id: "main", default: true }],
      },
    };
    const snapshot = {
      agentId: "main",
      agentDir: "/agent",
      config,
      metadataSnapshot: { plugins: [] },
      modelCatalog: {
        entries: [{ id: "claude-test", name: "Claude Test", provider: "anthropic" }],
        routeVariants: [],
      },
    } as unknown as PreparedModelRuntimeSnapshot;

    expect(
      buildModelRouteReadyCondition(
        config,
        {},
        {
          listOwners: () => [{ agentId: "main", agentDir: "/agent", config }],
          getSnapshot: () => snapshot,
          getProviderAuthStates: () =>
            new Map([
              [
                "main",
                {
                  agentId: "main",
                  configFingerprint: hashRuntimeConfigValue(config),
                  providers: new Map([["anthropic", available]]),
                  defaultModelRoute: {
                    provider: "anthropic",
                    modelId: "claude-test",
                    available,
                  },
                },
              ],
            ]),
        },
      ),
    ).toMatchObject({ status, reason });
  });

  it("reports unknown when published model auth evidence is absent", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "anthropic/claude-test" } },
        list: [{ id: "main", default: true }],
      },
    };
    const snapshot = {
      agentId: "main",
      agentDir: "/agent",
      config,
      metadataSnapshot: { plugins: [] },
      modelCatalog: {
        entries: [{ id: "claude-test", name: "Claude Test", provider: "anthropic" }],
        routeVariants: [],
      },
    } as unknown as PreparedModelRuntimeSnapshot;

    expect(
      buildModelRouteReadyCondition(
        config,
        {},
        {
          listOwners: () => [{ agentId: "main", agentDir: "/agent", config }],
          getSnapshot: () => snapshot,
          getProviderAuthStates: () => null,
        },
      ),
    ).toMatchObject({ status: "Unknown", reason: "ModelAuthStatusUnavailable" });
  });
});
