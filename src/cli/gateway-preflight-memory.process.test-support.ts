import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configuredLlamaCppMemoryConfig,
  createFixture,
  createGgufFixture,
  localMemoryConfig,
  runGateway,
  runPreflight,
  snapshotTree,
} from "./gateway-preflight.process.test-support.js";

export function registerGatewayPreflightMemoryProcessTests(): void {
  describe("gateway preflight CLI memory process", () => {
    it("reports a stable local llama.cpp blocker without mutating config or state", async () => {
      const fixture = await createFixture({
        config: localMemoryConfig(),
        disableMemorySlot: false,
        includeFixturePlugin: false,
        includeSharedStateDatabase: true,
        vectorModel: "embeddinggemma-300m",
      });
      const before = await snapshotTree(fixture.root);
      const env = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" };

      const first = await runPreflight(fixture, env);
      const second = await runPreflight(fixture, env);

      expect(first.code).toBe(1);
      expect(first.stdout).toBe(second.stdout);
      const result = JSON.parse(first.stdout) as {
        status: string;
        blockers: Array<{ code: string; provider?: string; message: string }>;
        errors: unknown[];
      };
      expect(result).toMatchObject({
        status: "blocked",
        errors: [],
        blockers: [
          expect.objectContaining({
            code: "managed-server-config-missing",
            provider: "local",
            message: expect.stringContaining(
              "Local embeddings need the managed llama.cpp server config",
            ),
          }),
        ],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
    });

    it("keeps a closed canonical shared-state database sidecar-free across built artifact reads", async () => {
      const fixture = await createFixture({
        config: {
          ...localMemoryConfig(),
          gateway: { mode: "local", auth: { mode: "none" } },
        },
        canonicalSharedStateDatabase: true,
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "embeddinggemma-300m",
      });
      const before = await snapshotTree(fixture.root);

      const result = await runPreflight(
        fixture,
        {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        },
        150_000,
      );

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "blocked",
        blockers: [expect.objectContaining({ code: "managed-server-config-missing" })],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
    }, 180_000);

    it("blocks configured local setup when the selected chat GGUF is missing", async () => {
      const embeddingModelPath = await createGgufFixture("embedding.gguf");
      const fixture = await createFixture({
        config: configuredLlamaCppMemoryConfig({ embeddingModelPath }),
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "embeddinggemma-300m",
      });
      const before = await snapshotTree(fixture.root);
      const preflightEnv = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" };

      const preflight = await runPreflight(fixture, preflightEnv);

      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        ok: false,
        status: "blocked",
        blockers: [
          expect.objectContaining({
            code: "chat-model-cache-missing",
            provider: "local",
            message: expect.stringContaining("/models/chat.gguf"),
          }),
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture, {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      });
      expect(startup.code).toBe(1);
      expect(startup.stderr).toMatch(/model file is missing: \/models\/chat\.gguf/i);
    }, 180_000);

    it("blocks configured local setup when the selected embedding GGUF is missing", async () => {
      const chatModelPath = await createGgufFixture("chat.gguf");
      const missingEmbeddingModelPath = path.join(
        os.tmpdir(),
        `openclaw-missing-embedding-${process.pid}-${Date.now()}.gguf`,
      );
      const fixture = await createFixture({
        config: configuredLlamaCppMemoryConfig({
          chatModelPath,
          embeddingModelPath: missingEmbeddingModelPath,
        }),
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "embeddinggemma-300m",
      });
      const before = await snapshotTree(fixture.root);
      const env = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" };

      const preflight = await runPreflight(fixture, env);

      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        ok: false,
        status: "blocked",
        blockers: [
          expect.objectContaining({
            code: "embedding-model-cache-missing",
            provider: "local",
            message: expect.stringContaining(missingEmbeddingModelPath),
          }),
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture, env);
      expect(startup.code).toBe(1);
      expect(startup.stderr).toContain(`Model file is missing: ${missingEmbeddingModelPath}`);
    }, 180_000);

    it("keeps an unresolved Hugging Face embedding source indeterminate and mutation-free", async () => {
      const chatModelPath = await createGgufFixture("chat.gguf");
      const fixture = await createFixture({
        config: configuredLlamaCppMemoryConfig({
          chatModelPath,
          embeddingModelPath: "hf:example/model-GGUF/model.gguf",
        }),
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "embeddinggemma-300m",
      });
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture, {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      });

      expect(preflight.code).toBe(2);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        ok: false,
        status: "indeterminate",
        blockers: [],
        errors: [
          expect.objectContaining({
            code: "inspection-indeterminate",
            message: expect.stringContaining("requires network resolution"),
          }),
        ],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
    });

    it("accepts configured local setup and a local provider with no semantic index", async () => {
      const chatModelPath = await createGgufFixture("chat.gguf");
      const embeddingModelPath = await createGgufFixture("embedding.gguf");
      const configured = await createFixture({
        config: configuredLlamaCppMemoryConfig({ chatModelPath, embeddingModelPath }),
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "embeddinggemma-300m",
      });
      const noIndex = await createFixture({
        config: localMemoryConfig(),
        disableMemorySlot: false,
        includeFixturePlugin: false,
      });
      const env = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" };

      for (const fixture of [configured, noIndex]) {
        const before = await snapshotTree(fixture.root);
        const result = await runPreflight(fixture, env);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          status: "ready",
          blockers: [],
          errors: [],
        });
        expect(await snapshotTree(fixture.root)).toEqual(before);
      }
    });
  });
}
