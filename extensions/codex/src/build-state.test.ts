import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("shares one record across module copies of the same build", () => {
    const create = () => ({ items: new Set<string>() });
    const first = defineCodexBuildState("openclaw.codexBuildStateTest", create);
    const second = defineCodexBuildState("openclaw.codexBuildStateTest", create);

    first().items.add("shared");

    expect(second()).toBe(first());
    expect(second().items.has("shared")).toBe(true);
  });

  it("never hands a build the record written by a build with other fields", () => {
    const older = defineCodexBuildState("openclaw.codexBuildStateTest", () => ({
      items: new Set<string>(),
    }));
    const newer = defineCodexBuildState("openclaw.codexBuildStateTest", () => ({
      items: new Set<string>(),
      owners: new Map<string, string>(),
    }));

    older().items.add("stale");

    expect(newer()).not.toBe(older());
    expect(newer().owners).toBeInstanceOf(Map);
    expect(newer().items.size).toBe(0);
  });
});
