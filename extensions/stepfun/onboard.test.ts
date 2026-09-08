import { describe, expect, it } from "vitest";
import {
  applyStepFunPlanConfig,
  applyStepFunPlanConfigCn,
  applyStepFunStandardConfig,
  applyStepFunStandardConfigCn,
} from "./onboard.js";

describe.each([
  {
    name: "standard global",
    provider: "stepfun",
    apply: applyStepFunStandardConfig,
    rows: ["step-3.7-flash", "step-3.5-flash"],
  },
  {
    name: "standard China",
    provider: "stepfun",
    apply: applyStepFunStandardConfigCn,
    rows: ["step-3.7-flash", "step-3.5-flash"],
  },
  {
    name: "plan global",
    provider: "stepfun-plan",
    apply: applyStepFunPlanConfig,
    rows: ["step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"],
  },
  {
    name: "plan China",
    provider: "stepfun-plan",
    apply: applyStepFunPlanConfigCn,
    rows: ["step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"],
  },
])("StepFun $name setup", ({ provider, apply, rows }) => {
  it.each([undefined, "merge"] as const)(
    "leaves ordinary %s rows runtime-owned and retains aliases",
    (mode) => {
      const config = apply({ models: { mode } });

      expect(config.models?.providers?.[provider]?.models).toEqual([]);
      expect(config.agents?.defaults?.models?.[`${provider}/step-3.7-flash`]).toEqual({});
      expect(config.agents?.defaults?.models?.[`${provider}/step-3.5-flash`]?.alias).toBeDefined();
      expect(apply(config)).toEqual(config);
    },
  );

  it("retains the shipped replace catalog", () => {
    const config = apply({ models: { mode: "replace" } });
    expect(config.models?.providers?.[provider]?.models.map((model) => model.id)).toEqual(rows);
  });
});
