import {
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIMessageTestPlugin } from "./imessage.test-plugin.js";

beforeEach(() => {
  resetFacadeRuntimeStateForTest();
});

afterEach(() => {
  resetFacadeRuntimeStateForTest();
});

describe("createIMessageTestPlugin", () => {
  it("does not load the bundled iMessage facade by default", () => {
    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

    createIMessageTestPlugin();

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);
  });

  it("normalizes repeated transport prefixes without recursive stack growth", () => {
    const plugin = createIMessageTestPlugin();
    const prefixedHandle = `${"imessage:".repeat(5000)}+44 20 7946 0958`;

    expect(plugin.messaging?.normalizeTarget?.(prefixedHandle)).toBe("+442079460958");
  });
});
