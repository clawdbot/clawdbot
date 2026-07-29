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

  it("rejects route, tab, and browser-wide action escapes", () => {
    expect(() =>
      applyBrowserTabToolBinding({ action: "snapshot", targetId: "target-b" }, binding),
    ).toThrow("cannot override its run-bound tab target");
    expect(() =>
      applyBrowserTabToolBinding({ action: "snapshot", node: "other" }, binding),
    ).toThrow("cannot override its run-bound node");
    expect(() => applyBrowserTabToolBinding({ action: "open" }, binding)).toThrow(
      "unavailable in a tab-bound run",
    );
  });

  it("fails closed on malformed bindings", () => {
    expect(parseBrowserTabToolBinding({ kind: "tab", tabId: 1, target: "host" })).toEqual({
      ok: false,
      error: "browser tool binding requires target, profile, and targetId",
    });
  });
});
