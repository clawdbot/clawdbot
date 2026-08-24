import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareClaudeBridgeVersions,
  MANAGED_CLAUDE_BRIDGE_PACKAGE,
  MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH,
  MIN_CLAUDE_BRIDGE_VERSION,
} from "./version.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("compareClaudeBridgeVersions", () => {
  it.each([
    ["0.2.10", "0.2.11", -1],
    ["0.2.11", "0.2.11", 0],
    ["0.2.12", "0.2.11", 1],
    ["0.3.0", "0.2.11", 1],
    ["1.0.0", "0.2.11", 1],
    ["0.2.2", "0.2.11", -1], // numeric compare, not lexical (2 < 11)
  ] as const)("compares %s vs %s -> sign %d", (left, right, sign) => {
    expect(Math.sign(compareClaudeBridgeVersions(left, right))).toBe(sign);
  });

  it("treats an undefined running version as below any floor", () => {
    expect(compareClaudeBridgeVersions(undefined, MIN_CLAUDE_BRIDGE_VERSION)).toBeLessThan(0);
  });

  it("treats a prerelease as below the same stable release", () => {
    expect(compareClaudeBridgeVersions("0.2.11-beta.1", "0.2.11")).toBeLessThan(0);
    expect(compareClaudeBridgeVersions("0.2.11", "0.2.11-beta.1")).toBeGreaterThan(0);
  });

  it("treats build metadata as below the same stable release", () => {
    expect(compareClaudeBridgeVersions("0.2.11+build.5", "0.2.11")).toBeLessThan(0);
  });
});

function declaredPin(): string {
  const pkg = JSON.parse(readFileSync(path.resolve(HERE, "..", "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const rawPin = pkg.dependencies?.[MANAGED_CLAUDE_BRIDGE_PACKAGE];
  expect(rawPin, `${MANAGED_CLAUDE_BRIDGE_PACKAGE} must be a declared dependency`).toBeTruthy();
  return (rawPin ?? "").replace(/^[\^~=v]+/, "");
}

describe("MIN_CLAUDE_BRIDGE_VERSION contract", () => {
  it("never exceeds the dependency pin in package.json (floor cannot refuse a blessed binary)", () => {
    expect(
      compareClaudeBridgeVersions(MIN_CLAUDE_BRIDGE_VERSION, declaredPin()),
    ).toBeLessThanOrEqual(0);
  });
});

describe("MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH contract", () => {
  it("never exceeds the dependency pin (a feature gate the bundled binary can never satisfy is dead code)", () => {
    // If the gate outran the pin, the managed install would ALWAYS be below it
    // and the in-place refresh could never run — silently reverting every
    // catalog change to the expensive rotation path.
    expect(
      compareClaudeBridgeVersions(MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH, declaredPin()),
    ).toBeLessThanOrEqual(0);
  });

  it("is at or above the hard floor (gating below the minimum supported bridge is meaningless)", () => {
    expect(
      compareClaudeBridgeVersions(MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH, MIN_CLAUDE_BRIDGE_VERSION),
    ).toBeGreaterThanOrEqual(0);
  });
});
