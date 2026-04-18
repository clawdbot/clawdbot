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

    expect(parsed.errors).toEqual([]);
    expect(parsed.bindings).toEqual([
      { type: "route", agentId: "main", match: { channel: "matrix", accountId: "main" } },
    ]);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });
});
