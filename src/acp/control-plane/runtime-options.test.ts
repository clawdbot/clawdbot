/** Tests runtime config-option serialization against advertised backend keys. */
import { describe, expect, it } from "vitest";
import type { AcpSessionRuntimeOptions } from "../../config/sessions/types.js";
import { buildRuntimeConfigOptionPairs, mergeRuntimeOptions } from "./runtime-options.js";

describe("mergeRuntimeOptions", () => {
  it("clears top-level options when a patch explicitly sets them to undefined", () => {
    const patch = {
      runtimeMode: undefined,
      model: undefined,
      thinking: undefined,
      cwd: undefined,
      permissionProfile: undefined,
      timeoutSeconds: undefined,
    } as Partial<AcpSessionRuntimeOptions>;

    expect(
      mergeRuntimeOptions({
        current: {
          runtimeMode: "plan",
          model: "claude-sonnet-4.6",
          thinking: "high",
          cwd: "/tmp/project",
          permissionProfile: "trusted",
          timeoutSeconds: 120,
        },
        patch,
      }),
    ).toEqual({});
  });

  it("clears backend extras when a patch explicitly clears them", () => {
    expect(
      mergeRuntimeOptions({
        current: {
          model: "claude-sonnet-4.6",
          backendExtras: { provider: "anthropic", profile: "work" },
        },
        patch: { backendExtras: undefined } as Partial<AcpSessionRuntimeOptions>,
      }),
    ).toEqual({ model: "claude-sonnet-4.6" });
  });

  it("keeps merging backend extras when a patch provides new entries", () => {
    expect(
      mergeRuntimeOptions({
        current: { backendExtras: { provider: "anthropic" } },
        patch: { backendExtras: { profile: "work" } },
      }),
    ).toEqual({ backendExtras: { provider: "anthropic", profile: "work" } });
  });
});

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

describe("buildRuntimeConfigOptionPairs thinking advertisement", () => {
  it("omits automatic thinking when the backend advertises no thinking alias", () => {
    expect(buildRuntimeConfigOptionPairs({ thinking: "high" }, ["mode", "model"])).toEqual([]);
  });

  it("maps automatic thinking to the advertised reasoning_effort alias", () => {
    expect(
      buildRuntimeConfigOptionPairs({ thinking: "high" }, ["model", "reasoning_effort"]),
    ).toEqual([["reasoning_effort", "high"]]);
  });

  it("keeps automatic thinking when advertised keys are unknown", () => {
    expect(buildRuntimeConfigOptionPairs({ thinking: "high" })).toEqual([["thinking", "high"]]);
  });
});
