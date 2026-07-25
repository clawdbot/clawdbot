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

  it.each([
    {
      name: "foreign tab",
      input: { targetId: "target-b" },
      error: "cannot override its run-bound tab target",
    },
    {
      name: "foreign profile",
      input: { profile: "other" },
      error: "cannot override its run-bound profile",
    },
    {
      name: "foreign node",
      input: { node: "other" },
      error: "cannot override its run-bound node",
    },
    {
      name: "foreign target",
      input: { target: "host" },
      error: "cannot override its run-bound target",
    },
  ])("rejects page extraction on a $name", ({ input, error }) => {
    expect(() =>
      applyBrowserTabToolBinding(
        { action: "extract", query: "When does the release ship?", ...input },
        binding,
      ),
    ).toThrow(error);
  });

  it.each(["open", "start", "profiles"])(
    "keeps the browser-wide %s action unavailable to bound runs",
    (action) => {
      expect(() => applyBrowserTabToolBinding({ action }, binding)).toThrow(
        "unavailable in a tab-bound run",
      );
    },
  );

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
