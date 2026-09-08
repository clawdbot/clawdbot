import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { jsonResult } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";

const pluginTools = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("../plugins/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/tools.js")>()),
  resolvePluginTools: (params: unknown) => pluginTools.resolve(params),
}));

describe("MCP loopback OAuth tools", () => {
  it("exposes a plugin tool backed by a prepared OAuth profile", async () => {
    pluginTools.resolve.mockImplementation(
      (params: {
        context?: { activeModel?: { provider?: string; modelId?: string } };
        hasAuthForProvider?: (providerId: string) => boolean;
      }) =>
        params.hasAuthForProvider?.("xai") &&
        params.context?.activeModel?.provider === "anthropic" &&
        params.context.activeModel.modelId === "claude-haiku-4-5"
          ? [
              {
                name: "x_search",
                label: "X search",
                description: "X search",
                parameters: Type.Object({}),
                execute: async () => jsonResult({ ok: true }),
              },
            ]
          : [],
    );

    const result = await resolveMcpLoopbackScopedTools({
      cfg: {
        auth: { order: { xai: ["xai:oauth"] } },
        plugins: { allow: ["xai"] },
      } as OpenClawConfig,
      context: {
        sessionKey: "agent:main:main",
        agentId: "main",
        modelProvider: "anthropic",
        modelId: "claude-haiku-4-5",
        senderIsOwner: true,
      },
      authProfileStore: {
        version: 1,
        profiles: {
          "xai:oauth": {
            type: "oauth",
            provider: "xai",
            access: "xai-access-token",
            refresh: "xai-refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
    });

    expect(result.tools.map((tool) => tool.name)).toContain("x_search");
  });
});
