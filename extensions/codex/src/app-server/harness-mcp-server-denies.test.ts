import { describe, expect, it } from "vitest";
import {
  applyHarnessDeniedMcpServerOverrides,
  resolveDeniedInheritedMcpServerNames,
} from "./harness-mcp-server-denies.js";

describe("applyHarnessDeniedMcpServerOverrides", () => {
  it("returns the overrides untouched without denied servers", () => {
    const overrides = { mcpServers: { alpha: true } };
    expect(applyHarnessDeniedMcpServerOverrides(overrides, undefined)).toBe(overrides);
    expect(applyHarnessDeniedMcpServerOverrides(undefined, [])).toBeUndefined();
  });

  it("disables denied servers over session enables and keeps other overrides", () => {
    expect(
      applyHarnessDeniedMcpServerOverrides(
        { mcpServers: { alpha: true, beta: true }, mcpToolsDeny: { beta: ["search"] } },
        ["alpha", "gamma-mail"],
      ),
    ).toEqual({
      mcpServers: { alpha: false, beta: true, "gamma-mail": false },
      mcpToolsDeny: { beta: ["search"] },
    });
  });

  it("creates overrides when none exist", () => {
    expect(applyHarnessDeniedMcpServerOverrides(undefined, ["alpha"])).toEqual({
      mcpServers: { alpha: false },
    });
  });
});

describe("resolveDeniedInheritedMcpServerNames", () => {
  it("matches native servers by raw key or sanitized alias, case-insensitively", () => {
    expect(
      resolveDeniedInheritedMcpServerNames({
        inheritedServerNames: ["alpha", "Gamma-Mail", "gamma-mail", "beta", "delta"],
        deniedServerNames: ["Alpha", "Gamma Mail"],
        configuredServerNames: ["Alpha", "Gamma Mail", "beta"],
      }),
    ).toEqual(["Gamma-Mail", "alpha", "gamma-mail"]);
  });

  it("returns nothing without denies or without inherited matches", () => {
    expect(
      resolveDeniedInheritedMcpServerNames({
        inheritedServerNames: ["alpha"],
        deniedServerNames: undefined,
        configuredServerNames: ["alpha"],
      }),
    ).toEqual([]);
    expect(
      resolveDeniedInheritedMcpServerNames({
        inheritedServerNames: ["zeta"],
        deniedServerNames: ["alpha"],
        configuredServerNames: ["alpha"],
      }),
    ).toEqual([]);
  });
});
