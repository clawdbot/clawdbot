import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { getServiceActionPreflightFailure } from "./lifecycle-action-preflight.js";

afterEach(() => {
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

async function withIsolatedLifecycleState(
  run: (params: { agentDir: string }) => Promise<void>,
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
    await run({ agentDir });
    await expect(fs.access(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
}

describe("getServiceActionPreflightFailure", () => {
  it.each(["start", "restart"] as const)(
    "blocks %s when a legacy credential file exists",
    async (action) => {
      await withIsolatedLifecycleState(async ({ agentDir }) => {
        await fs.writeFile(path.join(agentDir, "auth-profiles.json"), "{}\n");

        await expect(getServiceActionPreflightFailure(action)).resolves.toEqual({
          message:
            "Auth profile store ~/state/agents/main/agent/openclaw-agent.sqlite requires legacy credential migration.",
          hints: ["Run `openclaw doctor --fix`, then retry this command."],
        });
      });
    },
  );

  it.each(["stop", "uninstall"] as const)(
    "allows %s with the same pending migration",
    async (action) => {
      await withIsolatedLifecycleState(async ({ agentDir }) => {
        await fs.writeFile(path.join(agentDir, "auth-profiles.json"), "{}\n");

        await expect(getServiceActionPreflightFailure(action)).resolves.toBeNull();
      });
    },
  );

  it.each(["start", "restart"] as const)(
    "allows %s when no legacy credential files exist",
    async (action) => {
      await withIsolatedLifecycleState(async () => {
        await expect(getServiceActionPreflightFailure(action)).resolves.toBeNull();
      });
    },
  );
});
