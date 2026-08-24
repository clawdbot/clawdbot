import { describe, expect, it } from "vitest";
import { clickClackPlugin } from "../channel-plugin-api.js";

describe("ClickClack channel capabilities", () => {
  it("advertises media delivery through the public plugin descriptor", () => {
    expect(clickClackPlugin.capabilities).toEqual({
      chatTypes: ["direct", "group"],
      threads: true,
      media: true,
      blockStreaming: true,
    });
  });

  it("projects credential source and status without exposing tokens or diagnostics", async () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          tokenFile: "/private/clickclack-unavailable-token",
        },
      },
    };
    const account = clickClackPlugin.config.resolveAccount(cfg, "default");
    const snapshot = await clickClackPlugin.status?.buildAccountSnapshot?.({ account, cfg });

    expect(snapshot).toMatchObject({
      configured: true,
      tokenSource: "tokenFile",
      tokenStatus: "configured_unavailable",
    });
    expect(snapshot).not.toHaveProperty("token");
    expect(snapshot).not.toHaveProperty("credentialDiagnostics");
  });
});
