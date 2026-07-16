// Covers plugin tool descriptor cache lifecycle and invalidation.
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveRuntimeConfigCacheKey: vi.fn((value: unknown) => {
    const id =
      value && typeof value === "object" && "id" in value
        ? String((value as { id?: unknown }).id)
        : "config";
    return `config:${id}:${JSON.stringify(value)}`;
  }),
}));

vi.mock("../config/runtime-snapshot.js", () => ({
  resolveRuntimeConfigCacheKey: hoisted.resolveRuntimeConfigCacheKey,
}));

import {
  buildPluginToolDescriptorCacheKey,
  capturePluginToolDescriptor,
  createPluginToolDescriptorConfigCacheKeyMemo,
} from "./tool-descriptor-cache.js";
import { resetPluginToolDescriptorCacheForTest } from "./tools.test-fixtures.js";

describe("plugin tool descriptor cache keys", () => {
  afterEach(() => {
    hoisted.resolveRuntimeConfigCacheKey.mockClear();
    resetPluginToolDescriptorCacheForTest();
  });

  it("memoizes config cache keys across plugin descriptor keys in one resolution pass", () => {
    const config = {
      id: "runtime",
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as never;
    const configCacheKeyMemo = createPluginToolDescriptorConfigCacheKeyMemo();

    for (let index = 0; index < 25; index += 1) {
      buildPluginToolDescriptorCacheKey({
        pluginId: `plugin-${index}`,
        source: `/tmp/plugin-${index}.js`,
        contractToolNames: [`tool_${index}`],
        ctx: {
          config,
          runtimeConfig: config,
          workspaceDir: "/tmp/workspace",
          agentDir: "/tmp/agent",
          agentId: "main",
          sessionKey: "agent:main",
          sessionId: "session",
        },
        currentRuntimeConfig: config,
        configCacheKeyMemo,
      });
    }

    expect(hoisted.resolveRuntimeConfigCacheKey).toHaveBeenCalledTimes(1);
  });

  it("preserves required gateway client capabilities in cached descriptors", () => {
    const cached = capturePluginToolDescriptor({
      pluginId: "demo",
      optional: false,
      tool: {
        name: "inline_demo",
        label: "Inline demo",
        description: "Render a demo",
        parameters: { type: "object", properties: {} },
        requiredClientCaps: ["inline-widgets"],
        execute: async () => ({ content: [], details: {} }),
      },
    });

    expect(cached.requiredClientCaps).toEqual(["inline-widgets"]);
  });

  it("isolates descriptor caches by declared gateway client capabilities", () => {
    const base = {
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["show_widget"],
      ctx: { workspaceDir: "/tmp/workspace" },
    };

    const caplessKey = buildPluginToolDescriptorCacheKey(base);
    const inlineKey = buildPluginToolDescriptorCacheKey({
      ...base,
      clientCaps: ["inline-widgets"],
    });

    expect(caplessKey).not.toBe(inlineKey);
  });

  it("keeps distinct config objects distinct within the memo", () => {
    const firstConfig = { id: "first" } as never;
    const secondConfig = { id: "second" } as never;
    const configCacheKeyMemo = createPluginToolDescriptorConfigCacheKeyMemo();

    const firstKey = buildPluginToolDescriptorCacheKey({
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        config: firstConfig,
        runtimeConfig: firstConfig,
      },
      currentRuntimeConfig: firstConfig,
      configCacheKeyMemo,
    });
    const secondKey = buildPluginToolDescriptorCacheKey({
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        config: secondConfig,
        runtimeConfig: secondConfig,
      },
      currentRuntimeConfig: secondConfig,
      configCacheKeyMemo,
    });

    expect(hoisted.resolveRuntimeConfigCacheKey).toHaveBeenCalledTimes(2);
    expect(firstKey).not.toBe(secondKey);
  });

  it("varies descriptor keys by active model metadata", () => {
    const base = {
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        workspaceDir: "/tmp/workspace",
        agentId: "main",
        activeModel: {
          provider: "openai",
          modelId: "gpt-5.4",
          modelRef: "openai/gpt-5.4",
        },
      },
    };

    const firstKey = buildPluginToolDescriptorCacheKey(base);
    const secondKey = buildPluginToolDescriptorCacheKey({
      ...base,
      ctx: {
        ...base.ctx,
        activeModel: {
          provider: "openrouter",
          modelId: "openrouter/auto",
          modelRef: "openrouter/auto",
        },
      },
    });

    expect(firstKey).not.toBe(secondKey);
  });

  it("varies descriptor keys by trusted owner state", () => {
    const base = {
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["owner_tool"],
      ctx: {
        workspaceDir: "/tmp/workspace",
        agentId: "main",
      },
    };

    const ownerKey = buildPluginToolDescriptorCacheKey({
      ...base,
      ctx: { ...base.ctx, senderIsOwner: true },
    });
    const nonOwnerKey = buildPluginToolDescriptorCacheKey({
      ...base,
      ctx: { ...base.ctx, senderIsOwner: false },
    });

    expect(ownerKey).not.toBe(nonOwnerKey);
  });

  it("varies descriptor keys by native channel identity", () => {
    const base = {
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        messageChannel: "feishu",
        nativeChannelId: "oc_first",
      },
    };

    const firstKey = buildPluginToolDescriptorCacheKey(base);
    const secondKey = buildPluginToolDescriptorCacheKey({
      ...base,
      ctx: {
        ...base.ctx,
        nativeChannelId: "oc_second",
      },
    });

    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps descriptor keys stable across config bookkeeping writes", () => {
    const firstConfig = {
      id: "runtime",
      meta: { lastTouchedAt: "2026-05-02T10:00:00.000Z" },
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
      wizard: { lastRunAt: "2026-05-02T10:00:00.000Z" },
    } as never;
    const secondConfig = {
      id: "runtime",
      meta: { lastTouchedAt: "2026-05-02T10:00:05.000Z" },
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
      wizard: { lastRunAt: "2026-05-02T10:00:05.000Z" },
    } as never;

    const firstKey = buildPluginToolDescriptorCacheKey({
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        config: firstConfig,
        runtimeConfig: firstConfig,
      },
      currentRuntimeConfig: firstConfig,
    });
    const secondKey = buildPluginToolDescriptorCacheKey({
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        config: secondConfig,
        runtimeConfig: secondConfig,
      },
      currentRuntimeConfig: secondConfig,
    });

    expect(firstKey).toBe(secondKey);
  });
});
