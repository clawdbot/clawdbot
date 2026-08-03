// Agent bind Matrix integration tests cover account binding resolution through plugin registry surfaces.
import { afterEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createBindingResolverTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { parseBindingSpecs } from "./agents.bindings.js";

const matrixBindingPlugin = createBindingResolverTestPlugin({
  id: "matrix",
  resolveBindingAccountId: ({ accountId, agentId }) => {
    const explicit = accountId?.trim();
    if (explicit) {
      return explicit;
    }
    const agent = agentId?.trim();
    return agent || "default";
  },
});

describe("agents bind matrix integration", () => {
  it("uses matrix plugin binding resolver when accountId is omitted", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({ agentId: "main", specs: ["matrix"], config: {} });

    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.bindings).toEqual([
      { type: "route", agentId: "main", match: { channel: "matrix", accountId: "main" } },
    ]);
  });

  it("rejects a binding spec with extra colon segments instead of silently truncating", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({ agentId: "main", specs: ["matrix:work:extra"], config: {} });

    expect(parsed.bindings).toEqual([]);
    expect(parsed.errors).toEqual([
      'Invalid binding "matrix:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
    ]);
  });

  it("still accepts a single channel:account binding", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({ agentId: "main", specs: ["matrix:work"], config: {} });

    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.bindings).toEqual([
      { type: "route", agentId: "main", match: { channel: "matrix", accountId: "work" } },
    ]);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });
});
