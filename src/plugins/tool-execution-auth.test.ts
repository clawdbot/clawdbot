import { describe, expect, it } from "vitest";
import {
  bindPluginToolExecutionAuth,
  createExecutionScopedPluginAuthContext,
} from "./tool-execution-auth.js";

function createAuth(token: string) {
  return {
    getDelegatedAccessToken: async () => ({ ok: true as const, token }),
  };
}

describe("plugin tool execution auth", () => {
  it("exposes delegated auth only while the owning tool executes", async () => {
    const scopedAuth = createExecutionScopedPluginAuthContext("demo");
    let detachedRead: Promise<unknown> | undefined;
    const tool = bindPluginToolExecutionAuth({
      pluginId: "demo",
      auth: createAuth("turn-token"),
      tool: {
        name: "demo",
        label: "demo",
        description: "demo",
        parameters: { type: "object", properties: {} },
        async execute() {
          const active = await scopedAuth.getDelegatedAccessToken({ provider: "msteams" });
          detachedRead = new Promise((resolve) => {
            setTimeout(
              () => resolve(scopedAuth.getDelegatedAccessToken({ provider: "msteams" })),
              0,
            );
          });
          return { content: [{ type: "text", text: "ok" }], details: active };
        },
      },
    });

    await expect(scopedAuth.getDelegatedAccessToken({ provider: "msteams" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(tool.execute("call", {}, undefined, undefined)).resolves.toMatchObject({
      details: { ok: true, token: "turn-token" },
    });
    await expect(detachedRead).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("isolates concurrent executions for the same plugin", async () => {
    const scopedAuth = createExecutionScopedPluginAuthContext("demo");
    const execute = async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: await scopedAuth.getDelegatedAccessToken({ provider: "msteams" }),
    });
    const first = bindPluginToolExecutionAuth({
      pluginId: "demo",
      auth: createAuth("first"),
      tool: { name: "first", label: "first", description: "first", parameters: {}, execute },
    });
    const second = bindPluginToolExecutionAuth({
      pluginId: "demo",
      auth: createAuth("second"),
      tool: { name: "second", label: "second", description: "second", parameters: {}, execute },
    });

    await expect(
      Promise.all([
        first.execute("first", {}, undefined, undefined),
        second.execute("second", {}, undefined, undefined),
      ]),
    ).resolves.toMatchObject([
      { details: { ok: true, token: "first" } },
      { details: { ok: true, token: "second" } },
    ]);
  });
});
