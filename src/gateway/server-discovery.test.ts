import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getTailnetHostname = vi.hoisted(() => vi.fn());

vi.mock("../infra/tailscale.js", () => ({ getTailnetHostname }));

import { resolveTailnetDnsHint } from "./server-discovery.js";

describe("resolveTailnetDnsHint", () => {
  const prevTailnetDns = { value: undefined as string | undefined };

  beforeEach(() => {
    prevTailnetDns.value = process.env.CLAWDBOT_TAILNET_DNS;
    delete process.env.CLAWDBOT_TAILNET_DNS;
    getTailnetHostname.mockReset();
  });

  afterEach(() => {
    if (prevTailnetDns.value === undefined) {
      delete process.env.CLAWDBOT_TAILNET_DNS;
    } else {
      process.env.CLAWDBOT_TAILNET_DNS = prevTailnetDns.value;
    }
  });

  test("returns env hint when disabled", async () => {
    process.env.CLAWDBOT_TAILNET_DNS = "studio.tailnet.ts.net.";
    const value = await resolveTailnetDnsHint({ enabled: false });
    expect(value).toBe("studio.tailnet.ts.net");
    expect(getTailnetHostname).not.toHaveBeenCalled();
  });

  test("skips tailscale lookup when disabled", async () => {
    const value = await resolveTailnetDnsHint({ enabled: false });
    expect(value).toBeUndefined();
    expect(getTailnetHostname).not.toHaveBeenCalled();
  });

  test("uses tailscale lookup when enabled", async () => {
    getTailnetHostname.mockResolvedValue("host.tailnet.ts.net");
    const value = await resolveTailnetDnsHint({ enabled: true });
    expect(value).toBe("host.tailnet.ts.net");
    expect(getTailnetHostname).toHaveBeenCalledTimes(1);
  });
});
