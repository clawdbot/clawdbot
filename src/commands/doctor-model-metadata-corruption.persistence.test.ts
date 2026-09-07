import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
} from "../config/io.audit.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";

describe("Doctor model metadata corruption persistence", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("strips an audit-proven generated fallback row and rematerializes catalog capabilities", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  api: "openai-chatgpt-responses",
                  baseUrl: "https://chatgpt.com/backend-api/codex",
                  models: [
                    {
                      id: "gpt-5.6-sol",
                      name: "gpt-5.6-sol",
                      contextWindow: 272_000,
                      contextTokens: 272_000,
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      maxTokens: 8192,
                      api: "openai-chatgpt-responses",
                    },
                  ],
                },
              },
            },
          });
          const before = await readConfigFileSnapshot();
          expect(before.hash).toBeTypeOf("string");
          const auditBase = createConfigWriteAuditRecordBase({
            configPath,
            env: process.env,
            existsBefore: true,
            previousHash: "before-materialization",
            nextHash: before.hash!,
            previousBytes: 100,
            nextBytes: Buffer.byteLength(before.raw ?? "", "utf-8"),
            previousMetadata: {
              dev: null,
              ino: null,
              mode: null,
              nlink: null,
              uid: null,
              gid: null,
            },
            changedPathCount: 96,
            changedPaths: [
              "models.providers.openai.models[0].reasoning",
              "models.providers.openai.models[0].input",
              "models.providers.openai.models[0].cost",
              "models.providers.openai.models[0].maxTokens",
            ],
            origin: "doctor",
            hasMetaBefore: true,
            hasMetaAfter: true,
            gatewayModeBefore: "local",
            gatewayModeAfter: "local",
            suspicious: [],
            processInfo: {
              pid: 1,
              ppid: 0,
              cwd: "/tmp",
              argv: ["openclaw", "update", "finalize", "--yes", "--channel", "dev"],
              execArgv: [],
            },
          });
          await appendConfigAuditRecord({
            env: process.env,
            homedir: () => home,
            record: finalizeConfigWriteAuditRecord({ base: auditBase, result: "rename" }),
          });

          const ctx = await prepareDoctorContext(configPath);
          expect(ctx.configResult.shouldWriteConfig).toBe(true);
          expect(ctx.cfg.models?.providers?.openai?.models[0]).not.toHaveProperty("reasoning");
          await runInitialConfigWriteHealth(ctx);

          const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
          expect(saved.agents.defaults?.systemAgent).toBeUndefined();
          expect(saved.agents.defaults?.heartbeat).toBeUndefined();
          expect(saved.models.providers.openai.models[0]).toMatchObject({
            id: "gpt-5.6-sol",
            name: "gpt-5.6-sol",
            api: "openai-chatgpt-responses",
            contextWindow: 272_000,
            contextTokens: 272_000,
          });
          for (const field of ["reasoning", "input", "cost", "maxTokens"]) {
            expect(saved.models.providers.openai.models[0]).not.toHaveProperty(field);
          }

          const reread = await readConfigFileSnapshot();
          expect(reread.sourceConfig.models?.providers?.openai?.models[0]).not.toHaveProperty(
            "reasoning",
          );
          expect(reread.config.models?.providers?.openai?.models[0]).toMatchObject({
            reasoning: true,
            input: ["text", "image"],
            maxTokens: 128_000,
          });
          expect((await prepareDoctorContext(configPath)).configResult.shouldWriteConfig).toBe(
            false,
          );
        },
      );
    });
  });
});
