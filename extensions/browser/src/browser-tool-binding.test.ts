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

  it("pins page extraction to the trusted tab and browser route", () => {
    expect(
      applyBrowserTabToolBinding(
        { action: "extract", query: "When does the release ship?" },
        binding,
      ),
    ).toEqual({
      action: "extract",
      query: "When does the release ship?",
      target: "node",
      node: "desktop",
      profile: "chrome",
      targetId: "target-a",
    });
  });

  it("rejects page extraction route escapes and browser-wide actions", () => {
    for (const [input, error] of [
      [{ targetId: "target-b" }, "cannot override its run-bound tab target"],
      [{ profile: "other" }, "cannot override its run-bound profile"],
      [{ node: "other" }, "cannot override its run-bound node"],
      [{ target: "host" }, "cannot override its run-bound target"],
    ] as const) {
      expect(() =>
        applyBrowserTabToolBinding(
          { action: "extract", query: "When does the release ship?", ...input },
          binding,
        ),
      ).toThrow(error);
    }
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
