import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "./state-migrations.workspace-setup.js";

export function useWorkspaceMigrationTestFixture() {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  function setup() {
    const homeDir = tempDirs.make("openclaw-workspace-migration-home-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(homeDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    envSnapshot ??= captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const cfg = {
      agents: { defaults: { workspace: workspaceDir } },
    } satisfies OpenClawConfig;
    return {
      cfg,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
      homeDir,
      stateDir,
      workspaceDir,
    };
  }

  function detect(context: ReturnType<typeof setup>) {
    return detectLegacyWorkspaceState({
      cfg: context.cfg,
      stateDir: context.stateDir,
      env: context.env,
      homedir: () => context.homeDir,
      doctorOnlyStateMigrations: true,
    });
  }

  async function migrate(context: ReturnType<typeof setup>) {
    return await migrateLegacyWorkspaceState({
      detected: detect(context),
      env: context.env,
      stateDir: context.stateDir,
    });
  }

  return { detect, migrate, setup };
}
