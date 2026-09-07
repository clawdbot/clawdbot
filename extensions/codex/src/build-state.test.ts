import { afterEach, describe, expect, it, vi } from "vitest";
import codexPluginPackage from "../package.json" with { type: "json" };
import { defineCodexBuildState } from "./build-state.js";

const globalState = globalThis as Record<symbol, unknown>;
const stateName = "openclaw.codexBuildStateTest";
const currentKey = Symbol.for(`${stateName}@${codexPluginPackage.version}`);
const olderKey = Symbol.for(`${stateName}@2026.7.1`);

describe("defineCodexBuildState", () => {
  afterEach(() => {
    for (const key of [currentKey, olderKey, Symbol.for(stateName)]) {
      delete globalState[key];
    }
  });

  it("shares mutations between independently loaded module copies", async () => {
    const first = defineCodexBuildState(stateName, () => ({ items: new Set<string>() }));
    first().items.add("first copy");
    vi.resetModules();
    const secondModule = await import("./build-state.js");
    const second = secondModule.defineCodexBuildState(stateName, () => ({
      items: new Set<string>(),
    }));
    second().items.add("second copy");

    expect(first().items).toEqual(new Set(["first copy", "second copy"]));
    expect(second()).toBe(first());
  });

  it("keeps another version's record available to its existing owner", () => {
    const older = { items: new Set(["old client"]) };
    globalState[olderKey] = older;
    const current = defineCodexBuildState(stateName, () => ({ items: new Set<string>() }));

    current().items.add("new client");

    expect(current().items).toEqual(new Set(["new client"]));
    expect(globalState[olderKey]).toBe(older);
    expect(older.items).toEqual(new Set(["old client"]));
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
