import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigFile, type OpenClawConfig } from "../config/config.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("Gateway workspace migration readiness", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("refuses startup for a secondary workspace until Doctor removes its legacy state", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR!;
    const workspaceDir = path.join(stateDir, "workspace-secondary");
    const cfg: OpenClawConfig = {
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: path.join(stateDir, "workspace-main") },
          secondary: { workspace: workspaceDir },
        },
      },
    };
    await writeConfigFile(cfg);
    await fs.mkdir(workspaceDir, { recursive: true });
    const sourcePath = path.join(workspaceDir, "openclaw-workspace-state.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T00:00:00.000Z" }),
    );
    const port = await getGatewayTestPort();

    await expect(startTestGatewayServer(port, { auth: { mode: "none" } })).rejects.toThrow(
      "Legacy workspace setup state requires migration",
    );
    await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
    await expect(fs.stat(sourcePath)).resolves.toBeDefined();

    const migration = await migrateLegacyWorkspaceState({
      stateDir,
      detected: detectLegacyWorkspaceState({
        cfg,
        stateDir,
        homedir: os.homedir,
        doctorOnlyStateMigrations: true,
      }),
    });
    expect(migration.warnings).toEqual([]);
    server = await startTestGatewayServer(port, { auth: { mode: "none" } });
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);
    await expect(fs.stat(sourcePath)).rejects.toHaveProperty("code", "ENOENT");
  });
});
