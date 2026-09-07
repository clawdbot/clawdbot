// Proves a fresh dev gateway can replace the synthetic implicit roster through real config IO.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import { ensureDevGatewayConfig } from "./dev.js";

describe("ensureDevGatewayConfig integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    resetConfigRuntimeState();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes the dedicated dev roster into a fresh state directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dev-config-integration-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspace = path.join(root, "workspace");

    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: workspace,
      },
      async () => {
        resetConfigRuntimeState();
        await ensureDevGatewayConfig({});
      },
    );

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      agents?: { entries?: Record<string, { default?: boolean; workspace?: string }> };
    };
    expect(config.agents?.entries).toEqual({
      dev: { default: true, workspace: `${workspace}-dev`, identity: expect.any(Object) },
    });
  });

  it("can retry after a partial dev workspace write fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dev-config-integration-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspace = path.join(root, "workspace");
    const devWorkspace = `${workspace}-dev`;

    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: workspace,
      },
      async () => {
        resetConfigRuntimeState();
        const realWriteFile = fs.writeFile.bind(fs);
        const writeSpy = vi
          .spyOn(fs, "writeFile")
          .mockImplementation(async (filePath, data, options) => {
            const rawPath = nodeFilePath(filePath);
            if (!rawPath) {
              return await realWriteFile(filePath, data, options);
            }
            const target = path.resolve(rawPath);
            const parent = path.dirname(target);
            const isStagedAgents =
              path.dirname(parent) === devWorkspace &&
              path.basename(parent).startsWith("openclaw-bootstrap-") &&
              path.basename(target) === "AGENTS.md";
            if (isStagedAgents) {
              await realWriteFile(filePath, "# PARTIAL\n", options);
              const error = new Error("ENOSPC") as NodeJS.ErrnoException;
              error.code = "ENOSPC";
              throw error;
            }
            return await realWriteFile(filePath, data, options);
          });

        try {
          await expect(ensureDevGatewayConfig({})).rejects.toMatchObject({ code: "ENOSPC" });
          await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.access(path.join(devWorkspace, "AGENTS.md"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } finally {
          writeSpy.mockRestore();
        }

        await ensureDevGatewayConfig({});
        const agents = await fs.readFile(path.join(devWorkspace, "AGENTS.md"), "utf8");
        expect(agents).toContain("gateway --dev");
        expect(agents).not.toBe("# PARTIAL\n");
        await expect(fs.access(configPath)).resolves.toBeUndefined();
      },
    );
  });
});
