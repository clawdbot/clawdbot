import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { listAgentEntries, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { openLocalAgentAvatarFile } from "../agents/identity-avatar-file.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { AVATAR_MAX_BYTES, isAvatarDataUrl, isAvatarHttpUrl } from "../shared/avatar-policy.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { readClawStatus } from "./lifecycle-state.js";
import type { PackageRemovalDeps } from "./package-remove.js";
import { isPortableClawAvatar } from "./schema-portability.js";
import { parseClawManifest } from "./schema.js";
import { MAX_MANAGED_WORKSPACE_BYTES } from "./source-limits.js";
import {
  CLAW_BOOTSTRAP_FILE_NAMES,
  CLAW_OUTPUT_STABILITY,
  CLAW_SCHEMA_VERSION,
  type ClawManifest,
  type ClawMcpServer,
} from "./types.js";

export const CLAW_EXPORT_RESULT_SCHEMA_VERSION = "openclaw.clawExportResult.v1" as const;
const MAX_EXPORT_FILE_BYTES = 1024 * 1024;

type AgentConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];
type ClawBootstrapFileName = (typeof CLAW_BOOTSTRAP_FILE_NAMES)[number];

type ClawExportResult = {
  schemaVersion: typeof CLAW_EXPORT_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  agentId: string;
  outputDirectory: string;
  manifest: ClawManifest;
  filesWritten: string[];
};

export class ClawExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawExportError";
  }
}

function portableAgent(agent: AgentConfig, avatar: string | undefined): ClawManifest["agent"] {
  const identity = {
    ...(agent.identity?.name ? { name: agent.identity.name } : {}),
    ...(agent.identity?.theme ? { theme: agent.identity.theme } : {}),
    ...(agent.identity?.emoji ? { emoji: agent.identity.emoji } : {}),
    ...(avatar ? { avatar } : {}),
  };
  const tools = {
    ...(agent.tools?.profile ? { profile: agent.tools.profile } : {}),
    ...(agent.tools?.allow?.length ? { allow: agent.tools.allow } : {}),
    ...(agent.tools?.alsoAllow?.length ? { alsoAllow: agent.tools.alsoAllow } : {}),
    ...(agent.tools?.deny?.length ? { deny: agent.tools.deny } : {}),
    ...(agent.tools?.fs?.workspaceOnly !== undefined
      ? { fs: { workspaceOnly: agent.tools.fs.workspaceOnly } }
      : {}),
  };
  return {
    id: agent.id,
    ...(agent.name ? { name: agent.name } : {}),
    ...(agent.description ? { description: agent.description } : {}),
    ...(Object.keys(identity).length > 0 ? { identity } : {}),
    ...(agent.groupChat?.mentionPatterns?.length
      ? { groupChat: { mentionPatterns: agent.groupChat.mentionPatterns } }
      : {}),
    ...(agent.sandbox
      ? {
          sandbox: {
            ...(agent.sandbox.mode ? { mode: agent.sandbox.mode } : {}),
            ...(agent.sandbox.scope ? { scope: agent.sandbox.scope } : {}),
            ...(agent.sandbox.workspaceAccess
              ? { workspaceAccess: agent.sandbox.workspaceAccess }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(agent.memorySearch
      ? {
          memorySearch: {
            ...(agent.memorySearch.enabled !== undefined
              ? { enabled: agent.memorySearch.enabled }
              : {}),
            ...(agent.memorySearch.rememberAcrossConversations !== undefined
              ? {
                  rememberAcrossConversations: agent.memorySearch.rememberAcrossConversations,
                }
              : {}),
            ...(agent.memorySearch.sources?.length ? { sources: agent.memorySearch.sources } : {}),
          },
        }
      : {}),
    ...(agent.heartbeat
      ? {
          heartbeat: {
            ...(agent.heartbeat.every ? { every: agent.heartbeat.every } : {}),
            ...(agent.heartbeat.activeHours
              ? {
                  activeHours: {
                    ...(agent.heartbeat.activeHours.start
                      ? { start: agent.heartbeat.activeHours.start }
                      : {}),
                    ...(agent.heartbeat.activeHours.end
                      ? { end: agent.heartbeat.activeHours.end }
                      : {}),
                    ...(agent.heartbeat.activeHours.timezone
                      ? { timezone: agent.heartbeat.activeHours.timezone }
                      : {}),
                  },
                }
              : {}),
            ...(agent.heartbeat.lightContext !== undefined
              ? { lightContext: agent.heartbeat.lightContext }
              : {}),
            ...(agent.heartbeat.isolatedSession !== undefined
              ? { isolatedSession: agent.heartbeat.isolatedSession }
              : {}),
            ...(agent.heartbeat.timeoutSeconds !== undefined
              ? { timeoutSeconds: agent.heartbeat.timeoutSeconds }
              : {}),
          },
        }
      : {}),
    ...(agent.humanDelay
      ? {
          humanDelay: {
            ...(agent.humanDelay.mode ? { mode: agent.humanDelay.mode } : {}),
            ...(agent.humanDelay.minMs !== undefined ? { minMs: agent.humanDelay.minMs } : {}),
            ...(agent.humanDelay.maxMs !== undefined ? { maxMs: agent.humanDelay.maxMs } : {}),
          },
        }
      : {}),
  };
}

function normalizedRelativePath(value: string): string {
  return value.split(sep).join("/");
}

function comparePortableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isClawBootstrapFileName(value: string): value is ClawBootstrapFileName {
  return (CLAW_BOOTSTRAP_FILE_NAMES as readonly string[]).includes(value);
}
function readPortableAvatar(params: {
  config: OpenClawConfig;
  agent: AgentConfig;
  workspace: string;
}): { source?: string; sidecar?: { path: string; content: Buffer } } {
  const source = params.agent.identity?.avatar?.trim();
  if (!source) {
    return {};
  }
  if (isAvatarHttpUrl(source)) {
    return {};
  }
  if (isAvatarDataUrl(source)) {
    return isPortableClawAvatar(source) ? { source } : {};
  }
  const opened = openLocalAgentAvatarFile({
    cfg: params.config,
    agentId: params.agent.id,
    source,
  });
  if (!opened.ok) {
    return {};
  }
  try {
    const content = readFileDescriptorBoundedSync(opened.file.fd, AVATAR_MAX_BYTES);
    const path = normalizedRelativePath(relative(params.workspace, opened.file.path));
    return { source: path, sidecar: { path, content } };
  } catch {
    return {};
  } finally {
    closeSync(opened.file.fd);
  }
}

function derivativePackageVersion(manifest: ClawManifest, contents: ExportContent[]): string {
  const hash = createHash("sha256").update(JSON.stringify(manifest));
  for (const file of contents.toSorted((left, right) =>
    comparePortableText(left.path, right.path),
  )) {
    hash.update(file.path).update("\0").update(file.content).update("\0");
  }
  return `0.0.0-export.${hash.digest("hex")}`;
}

type ExportContent = { path: string; content: Buffer };

function portableMcpServer(server: Record<string, unknown>): ClawMcpServer {
  const common = {
    ...(server.toolFilter && typeof server.toolFilter === "object"
      ? { toolFilter: server.toolFilter as ClawMcpServer["toolFilter"] }
      : {}),
    ...(typeof server.timeout === "number" ? { timeout: server.timeout } : {}),
    ...(typeof server.connectTimeout === "number" ? { connectTimeout: server.connectTimeout } : {}),
  };
  if (typeof server.url === "string") {
    if (server.transport !== "sse" && server.transport !== "streamable-http") {
      throw new Error("Managed remote MCP server has an unsupported transport.");
    }
    return {
      url: server.url,
      transport: server.transport,
      ...(server.auth === "oauth" ? { auth: "oauth" as const } : {}),
      ...common,
    };
  }
  if (typeof server.command !== "string") {
    throw new Error("Managed MCP server has neither a command nor a remote URL.");
  }
  return {
    command: server.command,
    ...(server.transport === "stdio" ? { transport: server.transport } : {}),
    ...(Array.isArray(server.args) ? { args: server.args as string[] } : {}),
    ...(server.env && typeof server.env === "object"
      ? { env: server.env as Record<string, string> }
      : {}),
    ...common,
  };
}

export async function exportClawAgent(
  agentId: string,
  outputDirectory: string,
  options: OpenClawStateDatabaseOptions & {
    config: OpenClawConfig;
    packageDeps?: PackageRemovalDeps;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
  },
): Promise<ClawExportResult> {
  const status = await readClawStatus(agentId, options);
  const record = status.records.find((candidate) => candidate.install.agentId === agentId);
  if (!record) {
    throw new ClawExportError(
      "claw_not_found",
      `No installed Claw agent matches ${JSON.stringify(agentId)}.`,
    );
  }
  if (record.install.status !== "complete") {
    throw new ClawExportError(
      "install_incomplete",
      `Installed Claw agent ${JSON.stringify(agentId)} is in ${JSON.stringify(record.install.status)} state; finish or repair it before export.`,
    );
  }
  const agent = listAgentEntries(options.config).find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new ClawExportError(
      "agent_missing",
      `Installed Claw agent ${JSON.stringify(agentId)} is missing from config.`,
    );
  }
  const currentWorkspace = await realpath(
    resolve(resolveAgentWorkspaceDir(options.config, agentId)),
  ).catch(() => resolve(resolveAgentWorkspaceDir(options.config, agentId)));
  if (currentWorkspace !== record.install.workspace) {
    throw new ClawExportError(
      "workspace_changed",
      `Agent ${JSON.stringify(agentId)} now resolves to workspace ${JSON.stringify(currentWorkspace)} instead of its recorded Claw workspace ${JSON.stringify(record.install.workspace)}.`,
    );
  }
  if (record.agentState !== "present") {
    throw new ClawExportError(
      "agent_drifted",
      `Agent ${JSON.stringify(agentId)} no longer matches its recorded Claw configuration.`,
    );
  }
  const driftedFiles = record.workspaceFiles.filter((file) => file.state !== "unchanged");
  if (driftedFiles.length > 0) {
    throw new ClawExportError(
      "workspace_files_drifted",
      `Cannot export drifted managed files: ${driftedFiles.map((file) => `${file.path} (${file.state})`).join(", ")}.`,
    );
  }
  const driftedPackages = record.packages.filter((pkg) => pkg.state !== "present");
  if (driftedPackages.length > 0) {
    throw new ClawExportError(
      "packages_drifted",
      `Cannot export drifted packages: ${driftedPackages.map((pkg) => `${pkg.kind}:${pkg.ref}@${pkg.version} (${pkg.state})`).join(", ")}.`,
    );
  }
  const unresolvedCronJobs = record.cronJobs.filter(
    (cron) => cron.status !== "complete" || !cron.schedulerJobId,
  );
  const unavailableMcpServers = record.mcpServers.filter((server) => server.state !== "present");
  if (unavailableMcpServers.length > 0) {
    throw new ClawExportError(
      "mcp_servers_unavailable",
      `Cannot export MCP servers with unresolved ownership or drift: ${unavailableMcpServers
        .map((server) => server.name)
        .join(", ")}.`,
    );
  }
  if (unresolvedCronJobs.length > 0) {
    throw new ClawExportError(
      "cron_jobs_unavailable",
      `Cannot export cron declarations with unresolved ownership: ${unresolvedCronJobs
        .map((cron) => cron.manifestId)
        .join(", ")}.`,
    );
  }

  const workspace = await fsSafeRoot(record.install.workspace, {
    hardlinks: "reject",
    maxBytes: MAX_EXPORT_FILE_BYTES,
    symlinks: "reject",
  });
  const contents: ExportContent[] = await Promise.all(
    record.workspaceFiles.map(async (file) => ({
      path: normalizedRelativePath(file.path),
      content: await workspace.readBytes(file.path, { maxBytes: MAX_EXPORT_FILE_BYTES }),
    })),
  );
  const avatar = readPortableAvatar({
    config: options.config,
    agent,
    workspace: record.install.workspace,
  });
  const managedPaths = new Set(contents.map((file) => file.path));
  if (avatar.sidecar && !managedPaths.has(avatar.sidecar.path)) {
    contents.push(avatar.sidecar);
  }
  const aggregateBytes = contents.reduce((total, file) => total + file.content.byteLength, 0);
  if (aggregateBytes > MAX_MANAGED_WORKSPACE_BYTES) {
    throw new ClawExportError(
      "workspace_files_oversized",
      `Exported workspace content exceeds ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`,
    );
  }
  const bootstrapFiles: ClawManifest["workspace"]["bootstrapFiles"] = {};
  const files: ClawManifest["workspace"]["files"] = [];
  for (const file of contents) {
    const source = `workspace/${file.path}`;
    if (isClawBootstrapFileName(file.path)) {
      bootstrapFiles[file.path] = { source };
    } else {
      files.push({ source, path: file.path });
    }
  }
  const configuredMcpServers = normalizeConfiguredMcpServers(
    options.sourceMcpServers ?? options.config.mcp?.servers,
  );
  const manifest: ClawManifest = {
    schemaVersion: CLAW_SCHEMA_VERSION,
    agent: portableAgent(agent, avatar.source),
    workspace: { bootstrapFiles, files },
    packages: record.packages
      .map((pkg) => ({
        kind: pkg.kind,
        source: pkg.source,
        ref: pkg.ref,
        version: pkg.version,
      }))
      .toSorted((left, right) => {
        const leftIdentity = `${left.kind}:${left.ref}:${left.version}`;
        const rightIdentity = `${right.kind}:${right.ref}:${right.version}`;
        return comparePortableText(leftIdentity, rightIdentity);
      }),
    mcpServers: Object.fromEntries(
      record.mcpServers.map((ref) => [
        ref.name,
        portableMcpServer(configuredMcpServers[ref.name]!),
      ]),
    ),
    cronJobs: record.cronJobs
      .map((cron) => cron.job)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
  const parsed = parseClawManifest(manifest);
  if (!parsed.ok) {
    throw new ClawExportError(
      "export_manifest_invalid",
      parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    );
  }

  const target = resolve(resolveUserPath(outputDirectory));
  await mkdir(dirname(target), { recursive: true });
  try {
    await mkdir(target);
  } catch (error) {
    throw new ClawExportError(
      "output_collision",
      `Export directory ${JSON.stringify(target)} must not already exist: ${(error as Error).message}`,
    );
  }
  const filesWritten: string[] = [];
  try {
    const output = await fsSafeRoot(target, {
      hardlinks: "reject",
      maxBytes: MAX_EXPORT_FILE_BYTES,
      symlinks: "reject",
    });
    for (const file of contents) {
      const path = `workspace/${file.path}`;
      await output.write(path, file.content, { mkdir: true, overwrite: false });
      filesWritten.push(path);
    }
    const packageJson = {
      name: `openclaw-claw-${record.install.agentId}`,
      version: derivativePackageVersion(manifest, contents),
      type: "module",
      openclaw: { claw: "CLAW.md" },
    };
    await output.write("package.json", Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`), {
      overwrite: false,
    });
    filesWritten.push("package.json");
    await output.write(
      "CLAW.md",
      Buffer.from(
        `---\n${stringifyYaml(manifest)}---\n\n# ${manifest.agent.name ?? manifest.agent.id}\n\n` +
          "This Claw creates one configured OpenClaw agent and workspace.\n",
      ),
      { overwrite: false },
    );
    filesWritten.push("CLAW.md");
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw new ClawExportError(
      "export_write_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    schemaVersion: CLAW_EXPORT_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    agentId,
    outputDirectory: target,
    manifest,
    filesWritten,
  };
}
