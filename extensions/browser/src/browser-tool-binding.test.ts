import { describe, expect, it } from "vitest";
import { applyBrowserTabToolBinding, parseBrowserTabToolBinding } from "./browser-tool-binding.js";

const binding = {
  kind: "tab" as const,
  tabId: 17,
  target: "node" as const,
  node: "desktop",
  profile: "chrome",
  targetId: "target-a",
};

describe("browser tab tool binding", () => {
  it("pins route and nested act targets to the trusted tab", () => {
    expect(
      applyBrowserTabToolBinding(
        { action: "act", request: { kind: "batch", actions: [{ kind: "click" }] } },
        binding,
      ),
    ).toMatchObject({
      target: "node",
      node: "desktop",
      profile: "chrome",
      targetId: "target-a",
      request: {
        targetId: "target-a",
        actions: [{ kind: "click", targetId: "target-a" }],
      },
    });
  });

  it("pins page snapshots to the trusted tab and browser route", () => {
    expect(applyBrowserTabToolBinding({ action: "snapshot" }, binding)).toEqual({
      action: "snapshot",
      target: "node",
      node: "desktop",
      profile: "chrome",
      targetId: "target-a",
    });
  });

  it("rejects page snapshot route escapes", () => {
    for (const [input, error] of [
      [{ targetId: "target-b" }, "cannot override its run-bound tab target"],
      [{ profile: "other" }, "cannot override its run-bound profile"],
      [{ node: "other" }, "cannot override its run-bound node"],
      [{ target: "host" }, "cannot override its run-bound target"],
    ] as const) {
      expect(() => applyBrowserTabToolBinding({ action: "snapshot", ...input }, binding)).toThrow(
        error,
      );
    }
  });

  it("fails closed on malformed bindings", () => {
    expect(parseBrowserTabToolBinding({ kind: "tab", tabId: 1, target: "host" })).toEqual({
      ok: false,
      error: "browser tool binding requires target, profile, and targetId",
    });
  });
});
