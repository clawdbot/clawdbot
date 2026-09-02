import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import * as onboarding from "../commands/onboard-agent.js";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { applySystemAgentSetup } from "./setup-apply.js";

const runtime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: (code) => {
    throw new Error(`exit:${code}`);
  },
};
const model = "openai/gpt-5.6-luna";

afterEach(() => {
  vi.restoreAllMocks();
  resetConfigRuntimeState();
});

describe("applySystemAgentSetup first-agent concurrency", () => {
  it.each([
    { phase: "before", agentId: "concurrent", error: /config changed before first-agent creation/ },
    { phase: "after", agentId: "other", error: /config changed|default agent changed/ },
  ] as const)(
    "rejects a roster changed $phase first-agent creation",
    async ({ phase, agentId, error }) => {
      const state = await createOpenClawTestState({ label: "setup-first-agent-race" });
      try {
        await state.writeConfig({ agents: { defaults: { model } } });
        const initial = await readConfigFileSnapshot();
        const initialRuntime = initial.runtimeConfig ?? initial.config;
        const ensureOnboardingAgent = onboarding.ensureOnboardingAgent;
        const replaceRoster = async () => {
          await state.writeConfig({ agents: { defaults: { model }, entries: { [agentId]: {} } } });
          resetConfigRuntimeState();
        };
        vi.spyOn(onboarding, "ensureOnboardingAgent").mockImplementationOnce(async (params) => {
          if (phase === "before") {
            await replaceRoster();
          }
          const created = await ensureOnboardingAgent(params);
          if (phase === "after") {
            await replaceRoster();
          }
          return created;
        });

        await expect(
          applySystemAgentSetup({
            workspace: state.workspaceDir,
            firstAgent: { name: "robby" },
            expectedAgentId: "main",
            expectedAgentDir: resolveAgentDir(initialRuntime, "main"),
            expectedModelRef: model,
            expectedConfigHash: initial.hash ?? null,
            surface: "gateway",
            runtime,
          }),
        ).rejects.toThrow(error);

        const after: unknown = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(after).toHaveProperty("agents.entries", { [agentId]: {} });
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        await state.cleanup();
      }
    },
  );
});
