import { describe, expect, it } from "vitest";
import { buildPromptBuildDropResult } from "./prompt-build-drop.js";

describe("prompt-build drop marker", () => {
  it("returns nothing when no contribution was dropped", () => {
    expect(buildPromptBuildDropResult([])).toBeUndefined();
  });

  it("names the plugin and the reason", () => {
    const marker = buildPromptBuildDropResult([
      { pluginId: "beads", reason: "handler-failed", detail: "timed out after 15000ms" },
    ])?.appendContext;
    expect(marker).toContain('<dropped_plugin_context hook="before_prompt_build">');
    expect(marker).toContain("beads (handler failed or timed out: timed out after 15000ms)");
    expect(marker).toContain("MISSING from this prompt, not empty");
    expect(marker).toContain("</dropped_plugin_context>");
  });

  it("lists every dropped plugin in one marker", () => {
    const marker = buildPromptBuildDropResult([
      { pluginId: "beads", reason: "nested-prompt-build" },
      { pluginId: "provenance", reason: "nested-prompt-build" },
    ])?.appendContext;
    expect(marker).toContain(
      "beads (skipped for a nested prompt build), provenance (skipped for a nested prompt build)",
    );
  });

  it("stays honest when the drop cannot be attributed to a plugin", () => {
    const marker = buildPromptBuildDropResult([
      { reason: "dispatch-failed", detail: "Error: boom" },
    ])?.appendContext;
    expect(marker).toContain("unknown plugin (hook dispatch failed: Error: boom)");
  });

  it("collapses and truncates long error detail so the marker stays short", () => {
    const marker = buildPromptBuildDropResult([
      { pluginId: "noisy", reason: "handler-failed", detail: `a\n b${"c".repeat(400)}` },
    ])?.appendContext;
    expect(marker).not.toContain("\n b");
    expect(marker).toContain("a bc");
    expect(marker?.length).toBeLessThan(600);
  });

  it("delivers the marker through the append-context slot only", () => {
    const result = buildPromptBuildDropResult([{ pluginId: "beads", reason: "handler-failed" }]);
    expect(result?.appendContext).toContain("beads (handler failed or timed out)");
    expect(result?.prependContext).toBeUndefined();
    expect(result?.systemPrompt).toBeUndefined();
    expect(result?.toolsAllow).toBeUndefined();
  });
});
