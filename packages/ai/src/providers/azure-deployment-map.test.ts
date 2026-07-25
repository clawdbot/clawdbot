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
        modelId: "GPT-5",
        deploymentMap: "other=deployment,missing-value=",
      }),
    ).toBe("GPT-5");
  });

  it("matches model ids case-insensitively while preserving deployment names", () => {
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "Gpt-4O",
        deploymentMap: "gpt-4o=Deployment-GPT-4o",
      }),
    ).toBe("Deployment-GPT-4o");
  });

  it("prefers an exact-case match over the case-insensitive fallback", () => {
    const deploymentMap = "GPT-4o=prod-a,gpt-4o=prod-b";
    expect(resolveAzureDeploymentNameFromMap({ modelId: "GPT-4o", deploymentMap })).toBe("prod-a");
    expect(resolveAzureDeploymentNameFromMap({ modelId: "gpt-4o", deploymentMap })).toBe("prod-b");
    expect(resolveAzureDeploymentNameFromMap({ modelId: "Gpt-4O", deploymentMap })).toBe("prod-b");
  });

  it("replaces the cached lookup when the source changes", () => {
    expect(
      resolveAzureDeploymentNameFromMap({ modelId: "GPT-4o", deploymentMap: "gpt-4o=prod-a" }),
    ).toBe("prod-a");
    expect(
      resolveAzureDeploymentNameFromMap({ modelId: "GPT-4o", deploymentMap: "gpt-4o=prod-b" }),
    ).toBe("prod-b");
    expect(
      resolveAzureDeploymentNameFromMap({ modelId: "GPT-4o", deploymentMap: "gpt-4o=prod-a" }),
    ).toBe("prod-a");
  });
});
