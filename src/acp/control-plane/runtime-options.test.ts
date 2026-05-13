import { describe, expect, it } from "vitest";
import { buildRuntimeConfigOptionPairs } from "./runtime-options.js";

describe("buildRuntimeConfigOptionPairs timeout advertisement", () => {
  it("omits the timeout pair when advertised keys exclude every timeout alias", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [
      "model",
      "thinking",
      "approval_policy",
    ]);
    expect(pairs).toEqual([]);
  });

  it("keeps the timeout pair when advertised keys include `timeout`", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, ["model", "timeout"]);
    expect(pairs).toEqual([["timeout", "60"]]);
  });

  it("keeps the timeout pair using the advertised `timeout_seconds` alias", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [
      "model",
      "timeout_seconds",
    ]);
    expect(pairs).toEqual([["timeout_seconds", "60"]]);
  });

  it("keeps the timeout pair when advertised keys are unknown (empty or undefined)", () => {
    expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 })).toEqual([["timeout", "60"]]);
    expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [])).toEqual([["timeout", "60"]]);
  });

  it("does not affect model or thinking emission when only timeout is unadvertised", () => {
    const pairs = buildRuntimeConfigOptionPairs(
      { model: "claude-sonnet-4.6", thinking: "high", timeoutSeconds: 60 },
      ["model", "thinking"],
    );
    expect(pairs).toEqual([
      ["model", "claude-sonnet-4.6"],
      ["thinking", "high"],
    ]);
  });
});
