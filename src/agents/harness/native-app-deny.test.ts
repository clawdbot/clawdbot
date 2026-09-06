import { describe, expect, it } from "vitest";
import {
  collectHarnessDeniedNativeAppPatterns,
  isHarnessNativeAppDenyPattern,
  normalizeHarnessNativeAppDenyPrefix,
} from "./native-app-deny.js";

const prefix = "mcp__codex_apps__";

describe("isHarnessNativeAppDenyPattern", () => {
  it("accepts whole-app and deny-all patterns in the namespace", () => {
    expect(isHarnessNativeAppDenyPattern("mcp__codex_apps__gamma_*", prefix)).toBe(true);
    expect(isHarnessNativeAppDenyPattern("mcp__codex_apps__*", prefix)).toBe(true);
  });

  it("rejects exact names, nested wildcards, and other namespaces", () => {
    expect(isHarnessNativeAppDenyPattern("mcp__codex_apps__gamma_send", prefix)).toBe(false);
    expect(isHarnessNativeAppDenyPattern("mcp__codex_apps__*_send_*", prefix)).toBe(false);
    expect(isHarnessNativeAppDenyPattern("mcp__other__*", prefix)).toBe(false);
    expect(isHarnessNativeAppDenyPattern("gamma-mail__*", prefix)).toBe(false);
  });
});

describe("collectHarnessDeniedNativeAppPatterns", () => {
  it("collects normalized patterns across policies, sorted and unique", () => {
    expect(
      collectHarnessDeniedNativeAppPatterns(
        [
          { deny: ["MCP__codex_apps__Gamma_*", "exec"] },
          undefined,
          { deny: ["mcp__codex_apps__gamma_*", "mcp__codex_apps__epsilon_*"] },
        ],
        normalizeHarnessNativeAppDenyPrefix(" MCP__codex_apps__ "),
      ),
    ).toEqual(["mcp__codex_apps__epsilon_*", "mcp__codex_apps__gamma_*"]);
  });

  it("returns nothing without a prefix or without matching denies", () => {
    expect(
      collectHarnessDeniedNativeAppPatterns([{ deny: ["mcp__codex_apps__x_*"] }], undefined),
    ).toEqual([]);
    expect(collectHarnessDeniedNativeAppPatterns([{ deny: ["alpha__*", "*"] }], prefix)).toEqual(
      [],
    );
    expect(normalizeHarnessNativeAppDenyPrefix("  ")).toBeUndefined();
  });
});
