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
    "does not infer ownership from a matching persistent %s route",
    async (mode) => {
      const env = captureEnv([
        "OPENCLAW_TEST_TAILSCALE_BINARY",
        "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
        "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
        "VITEST",
      ]);
      const marker = await installFixture(legacyRoute(mode === "funnel"), mode);
      const before = await readFile(marker, "utf8");

      try {
        await expect(
          startGatewayTailscaleExposure({
            tailscaleMode: mode,
            port: 18789,
            backend: { host: "127.0.0.1", port: 19000 },
            logTailscale: { info: () => undefined, warn: () => undefined },
          }),
        ).rejects.toThrow("ownership OpenClaw cannot prove; it was not modified");
        expect(await readFile(marker, "utf8")).toBe(before);
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
});
