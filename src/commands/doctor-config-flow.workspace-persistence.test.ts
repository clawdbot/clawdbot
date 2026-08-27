import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows } from "../cron/store/row-codec.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "../flows/doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";

async function prepareDoctorContext(configPath: string): Promise<DoctorHealthFlowContext> {
  const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
  const options: DoctorOptions = { nonInteractive: true, repair: true };
  const prompter = createDoctorPrompter({ runtime, options });
  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: (params) => prompter.confirm(params),
    runtime,
    prompter,
  });
  return {
    runtime,
    options,
    prompter,
    configResult,
    cfg: configResult.cfg,
    cfgForPersistence: structuredClone(configResult.cfg),
    sourceConfigValid: configResult.sourceConfigValid ?? true,
    configPath,
    stateDirExistedAtStart: true,
    ...(configResult.runWithPluginMetadataSnapshot
      ? { runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot }
      : {}),
    ...(configResult.invalidatePluginMetadataSnapshot
      ? { invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot }
      : {}),
  };
}

describe("Doctor workspace persistence", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("keeps the legacy owner on the shared workspace across later health writes", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const workspace = path.join(home, "shared-workspace");
        const configPath = await writeOpenClawConfig(home, {
          agents: {
            defaults: { workspace },
            entries: {
              main: { default: true },
              cursor: { workspace },
            },
          },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const ctx = await prepareDoctorContext(configPath);

        await runInitialConfigWriteHealth(ctx);
        expect((await readConfigFileSnapshot()).config.agents?.entries?.main?.workspace).toBe(
          workspace,
        );

        ctx.cfg = {
          ...ctx.cfg,
          gateway: { ...ctx.cfg.gateway, bind: "lan" },
        };
        await runWriteConfigHealth(ctx);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.agents?.ownership).toBe("explicit");
        expect(snapshot.config.agents?.entries?.main?.workspace).toBe(workspace);
      });
    });
  });

  it("persists cron runtime policy on the retained owner before rewriting its model", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await withEnvOverride(
        { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_STATE_DIR: stateDir },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            agents: {
              defaults: { systemAgent: { agentId: "ops" } },
              entries: { main: { default: true }, ops: {} },
            },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const storePath = path.join(stateDir, "cron", "jobs.json");
          await fs.mkdir(path.dirname(storePath), { recursive: true });
          await fs.writeFile(
            storePath,
            JSON.stringify({
              version: 1,
              jobs: [
                makeCronJob({
                  id: "retained-owner",
                  enabled: false,
                  payload: {
                    kind: "agentTurn",
                    message: "Do not run this disabled job",
                    model: "codex/gpt-5.6-sol",
                  },
                }),
              ],
            }),
          );

          let firstPolicies: unknown;
          let firstRows: unknown;
          for (const pass of [1, 2]) {
            const ctx = await prepareDoctorContext(configPath);
            await runInitialConfigWriteHealth(ctx);
            await runWriteConfigHealth(ctx);
            const snapshot = await readConfigFileSnapshot();
            const policies = {
              main: snapshot.config.agents?.entries?.main?.models,
              ops: snapshot.config.agents?.entries?.ops?.models,
            };
            const rows = loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath));
            expect.soft(snapshot.valid, `pass ${pass}`).toBe(true);
            expect.soft(snapshot.config.agents?.defaults?.systemAgent?.agentId).toBe("ops");
            expect.soft(policies, `pass ${pass}`).toEqual({
              main: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
              ops: undefined,
            });
            expect.soft(rows).toHaveLength(1);
            expect.soft(rows[0]?.agent_id).toBe("main");
            expect
              .soft(
                rows.map((row) => JSON.parse(row.job_json)),
                `pass ${pass}`,
              )
              .toMatchObject([{ agentId: "main", payload: { model: "openai/gpt-5.6-sol" } }]);
            if (pass === 2) {
              expect.soft(policies).toEqual(firstPolicies);
              expect.soft(rows).toEqual(firstRows);
            }
            firstPolicies = policies;
            firstRows = rows;
          }
        },
      );
    });
  });
});
