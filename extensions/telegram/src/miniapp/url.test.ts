import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveTelegramMiniAppUrls, TELEGRAM_MINIAPP_URL_ERROR } from "./url.js";

describe("resolveTelegramMiniAppUrls", () => {
  it("resolves HTTPS page and WSS gateway URLs from Tailscale Serve", async () => {
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
    }));
    const cfg = {
      gateway: {
        tailscale: { mode: "serve" },
        controlUi: { basePath: "/openclaw/" },
      },
    } satisfies OpenClawConfig;

    await expect(resolveTelegramMiniAppUrls({ cfg, runCommand })).resolves.toEqual({
      pageUrl: "https://host.tailnet.ts.net/__openclaw_tg_miniapp/",
      controlUiUrl: "https://host.tailnet.ts.net/openclaw",
      gatewayUrl: "wss://host.tailnet.ts.net/openclaw",
    });
    expect(runCommand).toHaveBeenCalledWith(["tailscale", "status", "--json"], {
      timeoutMs: 5000,
    });
  });

  it("uses service MagicDNS for Tailscale Serve service names", async () => {
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net" } }),
    }));
    const cfg = {
      gateway: {
        tailscale: { mode: "serve", serviceName: "svc:openclaw" },
      },
    } satisfies OpenClawConfig;

    await expect(resolveTelegramMiniAppUrls({ cfg, runCommand })).resolves.toMatchObject({
      pageUrl: "https://openclaw.tailnet.ts.net/__openclaw_tg_miniapp/",
      gatewayUrl: "wss://openclaw.tailnet.ts.net",
    });
  });

  it("fails loud when Tailscale mode is off or MagicDNS cannot resolve", async () => {
    await expect(resolveTelegramMiniAppUrls({ cfg: {} })).rejects.toThrow(
      TELEGRAM_MINIAPP_URL_ERROR,
    );
    await expect(
      resolveTelegramMiniAppUrls({
        cfg: { gateway: { tailscale: { mode: "funnel" } } },
        runCommand: async () => ({ code: 1, stdout: "" }),
      }),
    ).rejects.toThrow(TELEGRAM_MINIAPP_URL_ERROR);
  });
});
