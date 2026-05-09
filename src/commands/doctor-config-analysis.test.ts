import { describe, expect, it } from "vitest";
import {
  formatConfigPath,
  resolveConfigPathTarget,
  stripUnknownConfigKeys,
} from "./doctor-config-analysis.js";

describe("doctor config analysis helpers", () => {
  it("formats config paths predictably", () => {
    expect(formatConfigPath([])).toBe("<root>");
    expect(formatConfigPath(["channels", "slack", "accounts", 0, "token"])).toBe(
      "channels.slack.accounts[0].token",
    );
  });

  it("resolves nested config targets without throwing", () => {
    const target = resolveConfigPathTarget(
      { channels: { slack: { accounts: [{ token: "x" }] } } },
      ["channels", "slack", "accounts", 0],
    );
    expect(target).toEqual({ token: "x" });
    expect(resolveConfigPathTarget({ channels: null }, ["channels", "slack"])).toBeNull();
  });

  it("strips unknown config keys while keeping known values", () => {
    const result = stripUnknownConfigKeys({
      hooks: {},
      unexpected: true,
    } as never);
    expect(result.removed).toContain("unexpected");
    expect((result.config as Record<string, unknown>).unexpected).toBeUndefined();
    expect((result.config as Record<string, unknown>).hooks).toStrictEqual({});
  });
});
