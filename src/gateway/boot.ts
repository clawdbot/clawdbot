// Gateway BOOT.md runner.
// Runs per-workspace boot checks in a run-owned temporary session.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  escapeInternalRuntimeContextDelimiters,
} from "../agents/internal-runtime-context.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { CliDeps } from "../cli/deps.types.js";
import { agentCommandFromSystem } from "../commands/agent.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readRegularFile } from "../infra/regular-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";
import { clearBootEchoContextForSession, setBootEchoContextForSession } from "./boot-echo-guard.js";

function generateBootSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `boot-${ts}-${suffix}`;
}

const log = createSubsystemLogger("gateway/boot");
const BOOT_FILENAME = "BOOT.md";

/** Result of attempting to run a workspace BOOT.md check. */
type BootRunResult =
  | { status: "skipped"; reason: "missing" | "empty" }
  | { status: "ran" }
  | { status: "failed"; reason: string };

function buildBootPrompt(content: string) {
  // Wrap BOOT.md content in internal-runtime-context delimiters so any
  // verbatim model echo (final reply or message-tool send) is removed by
  // the existing `stripInternalRuntimeContext` pathway. Mirrors the
  // runtime-context-prompt pattern from `e918e5f75c fix: hide runtime
  // context from submitted prompts`. The notice tells the model the
  // wrapped content is internal and should not be repeated to users.
  // Fixes #53732.
  const safeContent = escapeInternalRuntimeContextDelimiters(content);
  return [
    "You are running a boot check. Follow BOOT.md instructions exactly.",
    "",
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    OPENCLAW_RUNTIME_CONTEXT_NOTICE,
    "",
    "BOOT.md:",
    safeContent,
    INTERNAL_RUNTIME_CONTEXT_END,
    "",
    "If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
    "Use the `target` field (not `to`) for message tool destinations.",
    `After sending with the message tool, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
    `If nothing needs attention, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
  ].join("\n");
}

const MAX_BOOT_FILE_BYTES = 16 * 1024 * 1024;

async function loadBootFile(
  workspaceDir: string,
): Promise<{ content?: string; status: "ok" | "missing" | "empty" }> {
  const bootPath = path.join(workspaceDir, BOOT_FILENAME);

  // Resolve symlinks so BOOT.md can be a readable symlink to a regular file
  // while keeping directory/permission/size-limit failures surfaced to the
  // operator. ENOENT from either resolution or the bounded open keeps the
  // established readFile contract: treat disappearance as missing.
  let buffer: Buffer;
  try {
    const resolvedPath = await fs.realpath(bootPath);
    ({ buffer } = await readRegularFile({
      filePath: resolvedPath,
      maxBytes: MAX_BOOT_FILE_BYTES,
    }));
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === "ENOENT") {
      return { status: "missing" };
    }
    throw err;
  }
  const content = buffer.toString("utf-8");
  const trimmed = content.trim();
  if (!trimmed) {
    return { status: "empty" };
  }
  return { status: "ok", content: trimmed };
}

export async function runBootOnce(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  workspaceDir: string;
  agentId?: string;
}): Promise<BootRunResult> {
  const bootRuntime: RuntimeEnv = {
    log: () => {},
    error: (message) => log.error(String(message)),
    exit: defaultRuntime.exit,
  };
  let result: Awaited<ReturnType<typeof loadBootFile>>;
  try {
    result = await loadBootFile(params.workspaceDir);
  } catch (err) {
    const message = formatErrorMessage(err);
    log.error(`boot: failed to read ${BOOT_FILENAME}: ${message}`);
    return { status: "failed", reason: message };
  }

  if (result.status === "missing" || result.status === "empty") {
    return { status: "skipped", reason: result.status };
  }

  const mainSessionKey = params.agentId
    ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId })
    : resolveMainSessionKey(params.cfg);
  const message = buildBootPrompt(result.content ?? "");
  const sessionId = generateBootSessionId();
  const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
  // A run-owned key avoids rebinding a retained boot session, which would reject
  // admission or discard its collaboration state when the session ID rotates.
  const sessionKey = `agent:${agentId}:boot:${sessionId}`;
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  let ownedSessionId = sessionId;
  let agentFailure: string | undefined;
  let cleanupFailure: string | undefined;
  // Message tools use this exact run key to suppress unwrapped BOOT.md echoes.
  setBootEchoContextForSession(sessionKey, message);
  try {
    await agentCommandFromSystem(
      {
        message,
        sessionKey,
        sessionId,
        deliver: false,
        suppressPromptPersistence: true,
        onSessionIdChanged: (nextSessionId) => {
          ownedSessionId = nextSessionId;
        },
      },
      { boundary: "gateway.boot" },
      bootRuntime,
      params.deps,
    );
  } catch (err) {
    agentFailure = formatErrorMessage(err);
    log.error(`boot: agent run failed: ${agentFailure}`);
  } finally {
    clearBootEchoContextForSession(sessionKey);
    try {
      await applySessionEntryLifecycleMutation({
        agentId,
        storePath,
        // Follow committed run rotations, but preserve an operator's replacement.
        removals: [
          { sessionKey, expectedSessionId: ownedSessionId, archiveRemovedTranscript: false },
        ],
        skipMaintenance: true,
      });
    } catch (err) {
      cleanupFailure = formatErrorMessage(err);
      log.error(`boot: failed to clean up session: ${cleanupFailure}`);
    }
  }

  if (!agentFailure && !cleanupFailure) {
    return { status: "ran" };
  }
  const reasonParts = [
    agentFailure ? `agent run failed: ${agentFailure}` : undefined,
    cleanupFailure ? `session cleanup failed: ${cleanupFailure}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return { status: "failed", reason: reasonParts.join("; ") };
}
