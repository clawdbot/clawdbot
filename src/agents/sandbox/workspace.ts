/**
 * Sandbox workspace bootstrapper.
 *
 * Creates sandbox workspaces and seeds agent bootstrap files through root-boundary reads.
 */
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OptionalBootstrapFileName } from "../../config/types.agent-defaults.js";
import { openRootFile } from "../../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserPath } from "../../utils.js";
import {
  MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  readWorkspaceBootstrapFile,
} from "../workspace-bootstrap-read.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
} from "../workspace.js";

const log = createSubsystemLogger("sandbox-workspace");

export async function ensureSandboxWorkspace(
  workspaceDir: string,
  seedFrom?: string,
  skipBootstrap?: boolean,
  skipOptionalBootstrapFiles?: OptionalBootstrapFileName[],
) {
  await fs.mkdir(workspaceDir, { recursive: true });
  if (seedFrom) {
    const seed = resolveUserPath(seedFrom);
    const files = [
      DEFAULT_AGENTS_FILENAME,
      DEFAULT_SOUL_FILENAME,
      DEFAULT_TOOLS_FILENAME,
      DEFAULT_IDENTITY_FILENAME,
      DEFAULT_USER_FILENAME,
      DEFAULT_BOOTSTRAP_FILENAME,
      DEFAULT_HEARTBEAT_FILENAME,
    ];
    for (const name of files) {
      const src = path.join(seed, name);
      const dest = path.join(workspaceDir, name);
      try {
        await fs.access(dest);
      } catch {
        try {
          const opened = await openRootFile({
            absolutePath: src,
            rootPath: seed,
            boundaryLabel: "sandbox seed workspace",
          });
          if (!opened.ok) {
            continue;
          }
          try {
            const content = await readWorkspaceBootstrapFile(opened.fd);
            await fs.writeFile(dest, content, { encoding: "utf-8", flag: "wx" });
          } catch (err) {
            if (err instanceof RangeError) {
              log.warn(
                `Ignoring oversized sandbox seed file ${src}: file exceeds the ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES}-byte limit`,
              );
            }
            // ignore missing or oversized seed file
          } finally {
            syncFs.closeSync(opened.fd);
          }
        } catch {
          // ignore missing seed file
        }
      }
    }
  }
  await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: !skipBootstrap,
    skipOptionalBootstrapFiles,
  });
}
