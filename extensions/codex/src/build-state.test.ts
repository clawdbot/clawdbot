import { afterEach, beforeEach, describe, expect, it } from "vitest";
import codexPluginPackage from "../package.json" with { type: "json" };
import { defineCodexBuildState } from "./build-state.js";

const globalState = globalThis as Record<symbol, unknown>;
let symbolsBeforeTest = new Set<symbol>();

describe("defineCodexBuildState", () => {
  beforeEach(() => {
    symbolsBeforeTest = new Set(Object.getOwnPropertySymbols(globalThis));
  });

  afterEach(() => {
    for (const symbol of Object.getOwnPropertySymbols(globalThis)) {
      if (!symbolsBeforeTest.has(symbol)) {
        delete globalState[symbol];
      }
    }
  });

  it("shares one record with every module copy of the same plugin version", () => {
    // Another copy of this build (dist bundle beside the src bundle) already
    // wrote its record under the versioned key; this copy must find that one.
    const fromOtherCopy = { items: new Set<string>(["shared"]) };
    globalState[Symbol.for(`openclaw.codexBuildStateTest@${codexPluginPackage.version}`)] =
      fromOtherCopy;

    const getState = defineCodexBuildState("openclaw.codexBuildStateTest", () => ({
      items: new Set<string>(),
    }));

    expect(getState()).toBe(fromOtherCopy);
  });

  it("never hands this build a record from another key scheme, even with matching field names", () => {
    // The shipped 2026.8.1 build keyed by bare name; its record may carry the
    // same field names with a different entry contract.
    globalState[Symbol.for("openclaw.codexBuildStateTest")] = { items: ["stale"] };

    const getState = defineCodexBuildState("openclaw.codexBuildStateTest", () => ({
      items: new Set<string>(),
    }));

    expect(getState().items).toBeInstanceOf(Set);
    expect(getState().items.size).toBe(0);
  });
});
