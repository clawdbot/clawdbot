import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGatewayStabilityRuntimeOptions } from "./gateway-stability-runtime-contract.js";

describe("gateway stability runtime CLI", () => {
  it("keeps the full operator workflow in the QA script scenario", () => {
    const scenario = fs.readFileSync(
      "qa/scenarios/observability/gateway-stability-runtime.yaml",
      "utf8",
    );
    expect(scenario).toContain("kind: script");
    expect(scenario).toContain("path: test/e2e/qa-lab/runtime/gateway-stability-runtime.ts");
  });

  it("requires one bounded artifact destination", () => {
    expect(parseGatewayStabilityRuntimeOptions(["--artifact-base", "artifacts"], "/repo")).toEqual({
      artifactBase: "/repo/artifacts",
      repoRoot: "/repo",
    });
    expect(() => parseGatewayStabilityRuntimeOptions([])).toThrow("--artifact-base is required");
    expect(() => parseGatewayStabilityRuntimeOptions(["--artifact-base", "--other"])).toThrow(
      "--artifact-base requires a value",
    );
  });
});
