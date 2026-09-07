import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../../config/config.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { getServiceActionPreflightFailure } from "./lifecycle-action-preflight.js";

afterEach(() => {
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

async function withIsolatedLifecycleState(
  run: (params: { agentDir: string; configPath: string }) => Promise<void>,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-lifecycle-action-preflight-" }, async (root) => {
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n");
    vi.stubEnv("HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    resetConfigRuntimeState();
    await run({ agentDir, configPath });
    await expect(fs.access(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
}

describe("getServiceActionPreflightFailure", () => {
  // A retired credential file no longer blocks the service: the Gateway boots and
  // marks that auth owner configured-unavailable, so one stale file cannot keep
  // every other channel and provider offline.
  it.each(["start", "restart", "stop", "uninstall"] as const)(
    "allows %s when a legacy credential file exists",
    async (action) => {
      await withIsolatedLifecycleState(async ({ agentDir }) => {
        await fs.writeFile(path.join(agentDir, "auth-profiles.json"), "{}\n");

        await expect(getServiceActionPreflightFailure(action)).resolves.toBeNull();
      });
    },
  );

  it("allows stopping before plugin config migration while retaining the newer-writer guard", async () => {
    await withIsolatedLifecycleState(async ({ configPath }) => {
      const pluginRoot = path.join(path.dirname(configPath), "migration-fixture");
      await fs.mkdir(pluginRoot);
      await fs.writeFile(path.join(pluginRoot, "index.js"), "export default {};\n");
      await fs.writeFile(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "migration-fixture",
          version: "2.0.0",
          openclaw: { extensions: ["./index.js"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: "migration-fixture",
          configSchema: {
            type: "object",
            required: ["current"],
            properties: { current: { type: "boolean" } },
            additionalProperties: false,
          },
        }),
      );
      const config = {
        plugins: {
          allow: ["migration-fixture"],
          load: { paths: [pluginRoot] },
          entries: { "migration-fixture": { enabled: true, config: { legacy: true } } },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      resetConfigRuntimeState();
      const snapshot = await readConfigFileSnapshot({ observe: false });
      expect(snapshot.valid).toBe(false);
      expect(
        snapshot.issues.some((issue) => issue.path.startsWith("plugins.entries.migration-fixture")),
      ).toBe(true);
      expect(await getServiceActionPreflightFailure("start")).not.toBeNull();
      expect(await getServiceActionPreflightFailure("restart")).not.toBeNull();
      expect(await getServiceActionPreflightFailure("stop")).toBeNull();

      await fs.writeFile(
        configPath,
        JSON.stringify({ ...config, meta: { lastTouchedVersion: "9999.1.1" } }),
      );
      resetConfigRuntimeState();
      expect((await getServiceActionPreflightFailure("stop"))?.message).toContain(
        "older than the config",
      );
    });
  });

  it.each(["start", "restart"] as const)(
    "allows %s when no legacy credential files exist",
    async (action) => {
      await withIsolatedLifecycleState(async () => {
        await expect(getServiceActionPreflightFailure(action)).resolves.toBeNull();
      });
    },
  );

  it.each(["start", "restart", "stop"] as const)(
    "renders actionable invalid-config diagnostics before %s",
    async (action) => {
      await withIsolatedLifecycleState(async ({ configPath }) => {
        await fs.writeFile(
          configPath,
          '{\n  meta: { lastTouchedVersion: "9999.1.1" },\n  gateway: { mode: "nope" },\n}\n',
        );
        resetConfigRuntimeState();

        const failure = await getServiceActionPreflightFailure(action);

        expect(failure?.message).toContain(
          'openclaw.json:3 — gateway.mode: Invalid input (allowed: "local", "remote"), got: "nope"',
        );
        expect(failure?.message).toContain(
          "Config was last written by OpenClaw 9999.1.1, but you are running",
        );
      });
    },
  );
});
