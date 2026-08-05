import { describe, expect, it, vi } from "vitest";
import { createActivationReadinessResolver, isReadinessCriterionSelected } from "./activation.js";
import type { ReadinessCondition } from "./conditions.js";

const CONFIG_CURRENT_CRITERION_ID = "openclaw.config-current";
const MODEL_ROUTE_READY_CRITERION_ID = "openclaw.model-route-ready";
const SECRETS_READY_CRITERION_ID = "openclaw.secrets-ready";

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
});
