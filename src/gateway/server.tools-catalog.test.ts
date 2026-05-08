import { describe, expect, it } from "vitest";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway tools.catalog", () => {
  it("returns core catalog data and includes tts", async () => {
    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      const res = await rpcReq<{
        agentId?: string;
        groups?: Array<{
          id?: string;
          source?: "core" | "plugin";
          tools?: Array<{ id?: string; source?: "core" | "plugin" }>;
        }>;
      }>(ws, "tools.catalog", {});

      expect(res.ok).toBe(true);
      expect(res.payload?.agentId).toEqual(expect.any(String));
      expect(res.payload?.agentId).not.toBe("");
      const mediaGroup = res.payload?.groups?.find((group) => group.id === "media");
      expect(mediaGroup?.tools?.some((tool) => tool.id === "tts" && tool.source === "core")).toBe(
        true,
      );
    });
  });

  it("supports includePlugins=false and rejects unknown agent ids", async () => {
    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });

      const noPlugins = await rpcReq<{
        groups?: Array<{ source?: "core" | "plugin" }>;
      }>(ws, "tools.catalog", { includePlugins: false });
      expect(noPlugins.ok).toBe(true);
      expect((noPlugins.payload?.groups ?? []).every((group) => group.source !== "plugin")).toBe(
        true,
      );

      const unknownAgent = await rpcReq(ws, "tools.catalog", { agentId: "does-not-exist" });
      expect(unknownAgent.ok).toBe(false);
      expect(unknownAgent.error?.message ?? "").toContain("unknown agent id");
    });
  });
});
