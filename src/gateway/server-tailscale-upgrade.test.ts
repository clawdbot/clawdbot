import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import { startGatewayTailscaleExposure } from "./server-tailscale.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("managed Tailscale upgrade", () => {
  const legacyRoute = (funnel = false, proxyPort = 18789) => {
    const host = "fixture.tailnet.ts.net:443";
    return {
      TCP: { "443": { HTTPS: true } },
      Web: { [host]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${proxyPort}/` } } } },
      ...(funnel ? { AllowFunnel: { [host]: true } } : {}),
    };
  };

  const installFixture = async (config: object, mode: "serve" | "funnel") => {
    const fixture = fileURLToPath(
      new URL("../../test/fixtures/tailscale-legacy-route-fixture.mjs", import.meta.url),
    );
    const marker = path.join(tempDirs.make("openclaw-tailscale-upgrade-"), "state");
    await writeFile(marker, JSON.stringify(config));
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = fixture;
    process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER = marker;
    process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE = mode;
    process.env.VITEST ??= "true";
    return marker;
  };

  it.each([
    ["serve", 443],
    ["serve", 18789],
    ["funnel", 19001],
  ] as const)("adopts a predecessor %s route to Gateway port %s", async (mode, port) => {
    const env = captureEnv([
      "OPENCLAW_TEST_TAILSCALE_BINARY",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
      "VITEST",
    ]);
    const marker = await installFixture(legacyRoute(mode === "funnel", port), mode);
    const info = vi.fn();
    let cleanup: (() => Promise<void>) | null = null;
    try {
      cleanup = await startGatewayTailscaleExposure({
        tailscaleMode: mode,
        port,
        backend: { host: "127.0.0.1", port: 19000 },
        logTailscale: { info, warn: () => undefined },
      });
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({});
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining("adopted from a previous OpenClaw release"),
      );
    } finally {
      await cleanup?.();
      env.restore();
    }
  });

  it.each([
    [
      "foreground claim",
      { Foreground: { "fixture-session": legacyRoute(false, 8096) } },
      /Foreground session fixture-session.*fixture\.tailnet\.ts\.net:443[\s\S]*stop the confirmed owning process/,
    ],
    ["foreign target", legacyRoute(false, 8096)],
    [
      "foreign sibling hostname",
      {
        ...legacyRoute(false, 8096),
        Web: {
          ...legacyRoute(false, 8096).Web,
          "old.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:18789/" } },
          },
        },
      },
    ],
    [
      "foreign sibling path",
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "fixture.tailnet.ts.net:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:18789/" },
              "/other": { Proxy: "http://127.0.0.1:8096/" },
            },
          },
        },
      },
    ],
  ])("does not modify a %s", async (_label, config, recovery = /--https=443 --set-path=\/ off/) => {
    const env = captureEnv([
      "OPENCLAW_TEST_TAILSCALE_BINARY",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
      "VITEST",
    ]);
    const marker = await installFixture(config, "serve");
    const before = await readFile(marker, "utf8");
    const exposure = startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      backend: { host: "127.0.0.1", port: 19000 },
      logTailscale: { info: () => undefined, warn: () => undefined },
    });
    try {
      await expect(exposure).rejects.toThrow(recovery);
      expect(await readFile(marker, "utf8")).toBe(before);
    } finally {
      await exposure.then(
        (cleanup) => cleanup?.(),
        () => undefined,
      );
      env.restore();
    }
  });

  it("does not mutate an independent Tailscale Service", async () => {
    const env = captureEnv([
      "OPENCLAW_TEST_TAILSCALE_BINARY",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
      "VITEST",
    ]);
    const marker = await installFixture({ Services: { "svc:other": legacyRoute() } }, "serve");
    const before = await readFile(marker, "utf8");

    try {
      const cleanup = await startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        backend: { host: "127.0.0.1", port: 19000 },
        logTailscale: { info: () => undefined, warn: () => undefined },
      });

      expect(await readFile(marker, "utf8")).toBe(before);
      await cleanup?.();
    } finally {
      env.restore();
    }
  });
});
