import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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

  it.each(["serve", "funnel"] as const)(
    "replaces the exact legacy persistent %s route with a foreground claim",
    async (mode) => {
      const env = captureEnv([
        "OPENCLAW_TEST_TAILSCALE_BINARY",
        "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
        "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
        "VITEST",
      ]);
      const marker = await installFixture(legacyRoute(mode === "funnel"), mode);

      try {
        const cleanup = await startGatewayTailscaleExposure({
          tailscaleMode: mode,
          port: 18789,
          backend: { host: "127.0.0.1", port: 19000 },
          logTailscale: { info: () => undefined, warn: () => undefined },
        });

        expect(await readFile(marker, "utf8")).toBe("cleared");
        await cleanup?.();
      } finally {
        env.restore();
      }
    },
  );

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

  it.each([
    ["mode mismatch", legacyRoute(true)],
    ["custom target", legacyRoute(false, 9000)],
    [
      "extra path",
      {
        ...legacyRoute(),
        Web: {
          "fixture.tailnet.ts.net:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:18789/" },
              "/other": { Proxy: "http://127.0.0.1:9000/" },
            },
          },
        },
      },
    ],
    ["foreground route", { ...legacyRoute(), Foreground: { session: legacyRoute() } }],
    ["same-port Service", { ...legacyRoute(), Services: { "svc:other": legacyRoute() } }],
  ])("leaves an ambiguous %s route unchanged and explains the conflict", async (_name, config) => {
    const env = captureEnv([
      "OPENCLAW_TEST_TAILSCALE_BINARY",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
      "VITEST",
    ]);
    const marker = await installFixture(config, "serve");
    const before = await readFile(marker, "utf8");

    try {
      await expect(
        startGatewayTailscaleExposure({
          tailscaleMode: "serve",
          port: 18789,
          backend: { host: "127.0.0.1", port: 19000 },
          logTailscale: { info: () => undefined, warn: () => undefined },
        }),
      ).rejects.toThrow("cannot safely migrate");
      expect(await readFile(marker, "utf8")).toBe(before);
    } finally {
      env.restore();
    }
  });
});
