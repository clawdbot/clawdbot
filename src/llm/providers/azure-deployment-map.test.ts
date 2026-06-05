// Azure deployment map tests cover model-to-deployment resolution.
import { describe, expect, it } from "vitest";
import {
  parseAzureDeploymentNameMap,
  resolveAzureDeploymentNameFromMap,
} from "./azure-deployment-map.js";

describe("Azure deployment name map", () => {
  it("preserves equals signs inside deployment names", () => {
    const map = parseAzureDeploymentNameMap("gpt-5=deployment=blue, ignored, gpt-4 = prod = east ");

    expect(map.get("gpt-5")).toBe("deployment=blue");
    expect(map.get("gpt-4")).toBe("prod = east");
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "gpt-5",
        deploymentMap: "gpt-5=deployment=blue",
      }),
    ).toBe("deployment=blue");
  });

  it("falls back to the model id when the map has no usable entry", () => {
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "gpt-5",
        deploymentMap: "other=deployment,missing-value=",
      }),
    ).toBe("gpt-5");
  });
});
