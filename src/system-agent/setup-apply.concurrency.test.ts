import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { applySystemAgentSetup } from "./setup-apply.js";

const runtime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: ((code: number) => {
    throw new Error(`exit:${code}`);
  }) as RuntimeEnv["exit"],
};

const sourceConfig = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
} satisfies OpenClawConfig;

async function writeConcurrentRoster(pathname: string, agentId: string): Promise<void> {
  await fs.writeFile(
    pathname,
    JSON.stringify({
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { [agentId]: {} },
      },
    }),
  );
  resetConfigRuntimeState();
}

async function writeInitialConfig() {
  const absent = await readConfigFileSnapshot();
  await fs.mkdir(path.dirname(absent.path), { recursive: true });
  await fs.writeFile(absent.path, JSON.stringify(sourceConfig));
  resetConfigRuntimeState();
  return await readConfigFileSnapshot();
}

afterEach(() => {
  resetConfigRuntimeState();
});

describe("applySystemAgentSetup first-agent concurrency", () => {
  it("rejects a same-route agent switch after the controlled first-agent handoff", async () => {
    await withTempHome(async () => {
      const initial = await writeInitialConfig();
      const initialRuntime = initial.runtimeConfig ?? initial.config;
      let commitCount = 0;

      await expect(
        applySystemAgentSetup(
          {
            workspace: "/tmp/openclaw-first-agent-race",
            firstAgent: { name: "robby" },
            expectedAgentId: "main",
            expectedAgentDir: resolveAgentDir(initialRuntime, "main"),
            expectedModelRef: "openai/gpt-5.5",
            surface: "gateway",
            runtime,
          },
          {
            commit: async (effect) => {
              commitCount += 1;
              if (commitCount === 2) {
                await writeConcurrentRoster(initial.path, "other");
              }
              return await effect();
            },
          },
        ),
      ).rejects.toThrow(/config changed|default agent changed/);

      const after = await readConfigFileSnapshot();
      expect(after.sourceConfig?.agents?.entries).toEqual({ other: {} });
    });
  });

  it("rejects a roster written before the conditional first-agent create", async () => {
    await withTempHome(async () => {
      const initial = await writeInitialConfig();

      await expect(
        applySystemAgentSetup(
          {
            workspace: "/tmp/openclaw-first-agent-race",
            firstAgent: { name: "robby" },
            expectedConfigHash: initial.hash ?? null,
            surface: "gateway",
            runtime,
          },
          {
            commit: async (effect) => {
              await writeConcurrentRoster(initial.path, "concurrent");
              return await effect();
            },
          },
        ),
      ).rejects.toThrow("config changed before first-agent creation");

      const after = await readConfigFileSnapshot();
      expect(after.sourceConfig?.agents?.entries).toEqual({ concurrent: {} });
    });
  });
});
