import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import { writeJson } from "../../infra/json-files.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import { isRecord } from "../bundle-mcp-adapter.js";

export function injectBundleMcpBackendArgs(
  backend: CliBackendConfig,
  inject: (args: string[] | undefined) => string[],
): CliBackendConfig {
  return {
    ...backend,
    args: inject(backend.args),
    resumeArgs: inject(backend.resumeArgs ?? backend.args ?? []),
  };
}

export async function writeTemporaryBundleMcpJson(
  prefix: string,
  value: unknown,
  fileName = "settings.json",
  atomic = true,
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(tempDir, fileName);
  if (atomic) {
    await writeJson(filePath, value, { trailingNewline: true });
  } else {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  }
  return {
    filePath,
    cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
  };
}

export function withOpenClawMcpCaptureHeader(
  config: Record<string, unknown>,
  captureKey: string,
  missingServerError?: string,
): Record<string, unknown> {
  const mcpServers = isRecord(config.mcpServers) ? config.mcpServers : {};
  const openclaw = isRecord(mcpServers.openclaw) ? mcpServers.openclaw : undefined;
  if (!openclaw && missingServerError) {
    throw new Error(missingServerError);
  }
  return applyMergePatch(config, {
    mcpServers: {
      openclaw: {
        headers: {
          "x-openclaw-cli-capture-key": captureKey,
        },
      },
    },
  }) as Record<string, unknown>;
}
