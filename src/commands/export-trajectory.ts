/** CLI command for exporting a session transcript as a trajectory artifact. */
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { pathExists } from "../infra/fs-safe.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  exportTrajectoryForCommand,
  formatTrajectoryCommandExportSummary,
  type TrajectoryCommandExportSummary,
} from "../trajectory/command-export.js";
import {
  ensureExplicitSessionStoreMigratedForCommand,
  ensureSessionStateMigratedForCommand,
} from "./session-state-migration.js";

type ExportTrajectoryCommandOptions = {
  sessionKey?: string;
  output?: string;
  store?: string;
  agent?: string;
  workspace?: string;
  json?: boolean;
  requestJsonBase64?: string;
};

type EncodedExportTrajectoryRequest = {
  sessionKey?: unknown;
  output?: unknown;
  store?: unknown;
  agent?: unknown;
  workspace?: unknown;
};

const ENCODED_EXPORT_REQUEST_RE = /^[A-Za-z0-9_-]{1,65536}$/u;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function decodeExportTrajectoryRequest(encoded: string): Partial<ExportTrajectoryCommandOptions> {
  const trimmed = encoded.trim();
  if (!ENCODED_EXPORT_REQUEST_RE.test(trimmed)) {
    throw new Error("Encoded trajectory export request is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Encoded trajectory export request is invalid JSON");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Encoded trajectory export request must be a JSON object");
  }
  const request = decoded as EncodedExportTrajectoryRequest;
  const opts: Partial<ExportTrajectoryCommandOptions> = {};
  const sessionKey = readOptionalString(request.sessionKey);
  if (sessionKey !== undefined) {
    opts.sessionKey = sessionKey;
  }
  const output = readOptionalString(request.output);
  if (output !== undefined) {
    opts.output = output;
  }
  const store = readOptionalString(request.store);
  if (store !== undefined) {
    opts.store = store;
  }
  const agent = readOptionalString(request.agent);
  if (agent !== undefined) {
    opts.agent = agent;
  }
  const workspace = readOptionalString(request.workspace);
  if (workspace !== undefined) {
    opts.workspace = workspace;
  }
  return opts;
}

function resolveExportTrajectoryOptions(
  opts: ExportTrajectoryCommandOptions,
): ExportTrajectoryCommandOptions {
  const encoded = opts.requestJsonBase64?.trim();
  if (!encoded) {
    return opts;
  }
  return {
    ...opts,
    ...decodeExportTrajectoryRequest(encoded),
  };
}

/** Resolves the requested session and exports its trajectory summary or JSON result. */
export async function exportTrajectoryCommand(
  opts: ExportTrajectoryCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  let resolvedOpts: ExportTrajectoryCommandOptions;
  try {
    resolvedOpts = resolveExportTrajectoryOptions(opts);
  } catch (error) {
    runtime.error(`Failed to decode trajectory export request: ${formatErrorMessage(error)}`);
    runtime.exit(1);
    return;
  }
  const sessionKey = resolvedOpts.sessionKey?.trim();
  if (!sessionKey) {
    runtime.error(
      `--session-key is required. Run ${formatCliCommand("openclaw sessions")} to choose a session.`,
    );
    runtime.exit(1);
    return;
  }
  const cfg = getRuntimeConfig();
  await ensureSessionStateMigratedForCommand(cfg);
  const targetAgentId = resolvedOpts.agent ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolvedOpts.store
    ? path.resolve(resolvedOpts.store)
    : resolveDefaultSessionStorePath(targetAgentId);
  await ensureExplicitSessionStoreMigratedForCommand(storePath, {
    onWarning: (warning) => runtime.error?.(warning),
  });
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    runtime.error(
      `Session not found: ${sessionKey}. Run ${formatCliCommand("openclaw sessions")} to see available sessions.`,
    );
    runtime.exit(1);
    return;
  }

  let sessionFile: string;
  try {
    sessionFile = resolveSessionFilePath(
      entry.sessionId,
      entry,
      resolveSessionFilePathOptions({ agentId: targetAgentId, storePath }),
    );
  } catch (error) {
    runtime.error(`Failed to resolve session file: ${formatErrorMessage(error)}`);
    runtime.exit(1);
    return;
  }
  if (!(await pathExists(sessionFile))) {
    runtime.error(
      `Session file not found for ${sessionKey}. Run ${formatCliCommand("openclaw doctor")} to inspect session storage.`,
    );
    runtime.exit(1);
    return;
  }

  let summary: TrajectoryCommandExportSummary;
  try {
    summary = await exportTrajectoryForCommand({
      outputPath: resolvedOpts.output,
      sessionFile,
      sessionId: entry.sessionId,
      sessionKey,
      workspaceDir: path.resolve(resolvedOpts.workspace ?? process.cwd()),
    });
  } catch (error) {
    runtime.error(`Failed to export trajectory: ${formatErrorMessage(error)}`);
    runtime.exit(1);
    return;
  }

  if (resolvedOpts.json) {
    writeRuntimeJson(runtime, summary);
    return;
  }
  runtime.log(formatTrajectoryCommandExportSummary(summary));
}
