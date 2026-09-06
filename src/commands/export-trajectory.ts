/** CLI command for exporting a session transcript as a trajectory artifact. */
import path from "node:path";
import { readNonBlankString, readStringValue } from "@openclaw/normalization-core/string-coerce";
import { resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  resolveSessionTranscriptReadTarget,
} from "../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  exportTrajectoryForCommand,
  formatTrajectoryCommandExportSummary,
  type TrajectoryCommandExportSummary,
} from "../trajectory/command-export.js";
import { resolveExplicitSessionStorePath } from "./session-store-targets.js";

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

function decodeExportTrajectoryRequest(encoded: string): Partial<ExportTrajectoryCommandOptions> {
  if (!ENCODED_EXPORT_REQUEST_RE.test(encoded)) {
    throw new Error("Encoded trajectory export request is invalid");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) {
    throw new Error("Encoded trajectory export request is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Encoded trajectory export request is invalid JSON");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Encoded trajectory export request must be a JSON object");
  }
  const request = decoded as EncodedExportTrajectoryRequest;
  const opts: Partial<ExportTrajectoryCommandOptions> = {};
  const sessionKey = readNonBlankString(request.sessionKey);
  if (sessionKey !== undefined) {
    opts.sessionKey = sessionKey;
  }
  const output = readNonBlankString(request.output);
  if (output !== undefined) {
    opts.output = output;
  }
  // Keep a present-but-blank store or agent so exportTrajectoryCommand rejects it
  // the way it rejects a blank flag, instead of silently selecting the default.
  const store = readStringValue(request.store);
  if (store !== undefined) {
    opts.store = store;
  }
  const agent = readStringValue(request.agent);
  if (agent !== undefined) {
    opts.agent = agent;
  }
  const workspace = readNonBlankString(request.workspace);
  if (workspace !== undefined) {
    opts.workspace = workspace;
  }
  return opts;
}

function resolveExportTrajectoryOptions(
  opts: ExportTrajectoryCommandOptions,
): ExportTrajectoryCommandOptions {
  const encoded = opts.requestJsonBase64;
  if (encoded === undefined || encoded.length === 0) {
    return opts;
  }
  return {
    ...opts,
    ...decodeExportTrajectoryRequest(encoded),
  };
}

function throwTrajectoryExportError(message: string): never {
  throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
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
    throwTrajectoryExportError(
      `Failed to decode trajectory export request: ${formatErrorMessage(error)}`,
    );
  }
  const sessionKey = resolvedOpts.sessionKey?.trim();
  if (!sessionKey) {
    throwTrajectoryExportError(
      `--session-key is required. Run ${formatCliCommand("openclaw sessions")} to choose a session.`,
    );
  }
  const requestedAgent = resolvedOpts.agent?.trim();
  if (resolvedOpts.agent !== undefined && !requestedAgent) {
    throwTrajectoryExportError("--agent must not be blank");
  }
  if (resolvedOpts.store !== undefined && !resolvedOpts.store.trim()) {
    throwTrajectoryExportError("--store must not be blank");
  }
  let targetAgentId: string;
  try {
    targetAgentId = requestedAgent
      ? resolveConfiguredAgentId(getRuntimeConfig(), requestedAgent)
      : resolveAgentIdFromSessionKey(sessionKey);
  } catch (error) {
    throwTrajectoryExportError(formatErrorMessage(error));
  }
  let storePath = resolvedOpts.store
    ? resolveSessionStorePathCore(resolvedOpts.store, { agentId: targetAgentId })
    : resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId: targetAgentId });
  if (resolvedOpts.store) {
    try {
      storePath = resolveExplicitSessionStorePath({
        storePath,
        inputStorePath: resolvedOpts.store,
        agentId: targetAgentId,
      });
    } catch (error) {
      throwTrajectoryExportError(formatErrorMessage(error));
    }
  }
  // CLI reads must not join the Gateway's writable SQLite lifecycle (#101290).
  const entry = loadSessionEntryReadOnly({
    agentId: targetAgentId,
    sessionKey,
    storePath,
  });
  if (!entry?.sessionId) {
    throwTrajectoryExportError(
      `Session not found: ${sessionKey}. Run ${formatCliCommand("openclaw sessions")} to see available sessions.`,
    );
  }

  let sessionTarget: ReturnType<typeof resolveSessionTranscriptReadTarget>;
  try {
    sessionTarget = resolveSessionTranscriptReadTarget({
      agentId: targetAgentId,
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey,
      storePath,
    });
  } catch (error) {
    throwTrajectoryExportError(`Failed to resolve session file: ${formatErrorMessage(error)}`);
  }
  let summary: TrajectoryCommandExportSummary;
  try {
    summary = await exportTrajectoryForCommand({
      outputPath: resolvedOpts.output,
      sessionTarget: {
        agentId: sessionTarget.agentId ?? targetAgentId,
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey ?? sessionKey,
        storePath: sessionTarget.storePath,
      },
      sessionId: entry.sessionId,
      sessionKey,
      workspaceDir: path.resolve(resolvedOpts.workspace ?? process.cwd()),
    });
  } catch (error) {
    throwTrajectoryExportError(`Failed to export trajectory: ${formatErrorMessage(error)}`);
  }

  if (resolvedOpts.json) {
    writeRuntimeJson(runtime, summary);
    return;
  }
  runtime.log(formatTrajectoryCommandExportSummary(summary));
}
