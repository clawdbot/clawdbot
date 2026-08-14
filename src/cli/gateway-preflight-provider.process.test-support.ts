import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configuredLlamaCppMemoryConfig,
  createFixture,
  localMemoryConfig,
  PREFLIGHT_FIXTURE_PLUGIN_ID,
  runGateway,
  runPreflight,
  snapshotTree,
} from "./gateway-preflight.process.test-support.js";

export function registerGatewayPreflightProviderProcessTests(): void {
  describe("gateway preflight CLI provider process", () => {
    it("fails closed when the selected embedding provider owner is disabled", async () => {
      const config = {
        ...configuredLlamaCppMemoryConfig(),
        gateway: { mode: "local", auth: { mode: "none" } },
        plugins: {
          entries: {
            "llama-cpp": { enabled: false },
          },
        },
      };
      const semantic = await createFixture({
        config,
        includeFixturePlugin: false,
        includeSharedStateDatabase: false,
        vectorModel: "embeddinggemma-300m",
      });
      const noIndex = await createFixture({
        config,
        includeFixturePlugin: false,
        includeSharedStateDatabase: false,
      });
      const before = await snapshotTree(semantic.root);
      const env = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" };

      const preflight = await runPreflight(semantic, env);

      expect(preflight.code).toBe(2);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [expect.objectContaining({ code: "inspection-indeterminate" })],
      });
      expect(await snapshotTree(semantic.root)).toEqual(before);

      const startup = await runGateway(semantic, env);
      expect(startup.code).not.toBe(0);
      expect(startup.stderr).toMatch(/unknown memory embedding provider: local/i);

      const noIndexResult = await runPreflight(noIndex, env);
      expect(noIndexResult.code).toBe(0);
      expect(JSON.parse(noIndexResult.stdout)).toMatchObject({
        status: "ready",
        blockers: [],
        errors: [],
      });
    }, 180_000);

    it("returns indeterminate for unsupported selected providers and invalid config", async () => {
      const remote = await createFixture({
        config: {
          gateway: { mode: "local" },
          memory: {
            search: {
              provider: "openai",
              fallback: "none",
              model: "text-embedding-3-small",
            },
          },
        },
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "text-embedding-3-small",
      });
      const invalid = await createFixture({
        config: { gateway: { mode: "not-a-mode" } },
      });

      const remoteResult = await runPreflight(remote, {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      });
      expect(remoteResult.code).toBe(2);
      expect(JSON.parse(remoteResult.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [expect.objectContaining({ code: "inspection-indeterminate" })],
      });
      expect(remoteResult.stdout).not.toContain("llama.cpp");

      const invalidResult = await runPreflight(invalid);
      expect(invalidResult.code).toBe(2);
      expect(JSON.parse(invalidResult.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [expect.objectContaining({ code: "invalid-config" })],
      });
    });

    it("does not execute configured external preflight or provider runtime code", async () => {
      const fixture = await createFixture({
        config: localMemoryConfig(),
        disableMemorySlot: false,
        includeFixturePlugin: true,
        vectorModel: "embeddinggemma-300m",
      });
      const runtimeSentinelPath = path.join(fixture.root, "provider-runtime-activated");
      const contractSentinelPath = path.join(fixture.root, "doctor-contract-loaded");

      const result = await runPreflight(fixture, {
        OPENCLAW_PREFLIGHT_ACTIVATION_SENTINEL: runtimeSentinelPath,
        OPENCLAW_PREFLIGHT_CONTRACT_SENTINEL: contractSentinelPath,
      });

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [
          expect.objectContaining({
            code: "external-plugin-inspection-unsupported",
            pluginId: PREFLIGHT_FIXTURE_PLUGIN_ID,
          }),
        ],
      });
      await expect(fs.access(contractSentinelPath)).rejects.toThrow();
      await expect(fs.access(runtimeSentinelPath)).rejects.toThrow();
    });
  });
}
