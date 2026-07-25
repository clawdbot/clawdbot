// Covers plugin middleware that can transform agent tool results.
import { describe, expect, it } from "vitest";
import {
  normalizeAgentToolResultMiddlewareRuntimeIds,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";

describe("normalizeAgentToolResultMiddlewareRuntimes", () => {
  it("defaults omitted runtimes to every supported runtime", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimes()).toEqual(["openclaw", "codex"]);
  });

  it("preserves an explicit empty runtime list", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimes({ runtimes: [] })).toEqual([]);
  });

  it("ignores unknown runtime ids from manifest metadata", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimeIds(["codex-app-server", "openclaw"])).toEqual([
      "openclaw",
    ]);
  });
});
