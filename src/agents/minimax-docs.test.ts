import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_DEFAULT_MODEL_REF,
  MINIMAX_TEXT_MODEL_REFS,
} from "../plugin-sdk/minimax.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const testingLiveDoc = fs.readFileSync(path.join(repoRoot, "docs/help/testing-live.md"), "utf8");
const minimaxDoc = fs.readFileSync(path.join(repoRoot, "docs/providers/minimax.md"), "utf8");

describe("MiniMax docs sync", () => {
  it("keeps the live-testing guide on the current MiniMax default", () => {
    expect(testingLiveDoc).toContain("MiniMax M2.7");
    expect(testingLiveDoc).toContain(MINIMAX_DEFAULT_MODEL_REF);
  });

  it("keeps the provider doc aligned with shared MiniMax ids", () => {
    expect(minimaxDoc).toContain(MINIMAX_DEFAULT_MODEL_ID);
    expect(minimaxDoc).toContain(MINIMAX_DEFAULT_MODEL_REF);
    expect(minimaxDoc).toContain(`Unknown model: ${MINIMAX_DEFAULT_MODEL_REF}`);
    for (const modelRef of MINIMAX_TEXT_MODEL_REFS.slice(3)) {
      expect(minimaxDoc).toContain(modelRef);
    }
    expect(minimaxDoc).not.toContain("(unreleased at the time of writing)");
  });
});
