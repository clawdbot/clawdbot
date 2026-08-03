import { describe, expect, it } from "vitest";
import { buildCodexHarnessAppServerArgs } from "./gateway-codex-harness.live-helpers.js";

describe("Codex harness app-server arguments", () => {
  it("places config overrides after the subcommand", () => {
    expect(buildCodexHarnessAppServerArgs(["model_context_window=922000"])).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      "model_context_window=922000",
    ]);
  });
});
