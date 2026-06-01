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
import { agentCommand } from "../commands/agent.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";
import { clearBootEchoContextForSession, setBootEchoContextForSession } from "./boot-echo-guard.js";

function generateBootSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `boot-${ts}-${suffix}`;
}

type SessionMappingSnapshot = {
  storePath: string;
  sessionKey: string;
  canRestore: boolean;
  hadEntry: boolean;
  entry?: SessionEntry;
};

const log = createSubsystemLogger("gateway/boot");
const BOOT_FILENAME = "BOOT.md";

export type BootRunResult =
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

function resolveBootSessionKey(sessionKey: string): string {
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  return `agent:${agentId}:boot`;
}

async function loadBootFile(
  workspaceDir: string,
): Promise<{ content?: string; status: "ok" | "missing" | "empty" }> {
  const bootPath = path.join(workspaceDir, BOOT_FILENAME);
  try {
    const content = await fs.readFile(bootPath, "utf-8");
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty" };
    }
    return { status: "ok", content: trimmed };
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === "ENOENT") {
      return { status: "missing" };
    }
    throw err;
  }
}

function snapshotSessionMapping(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): SessionMappingSnapshot {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[params.sessionKey];
    if (!entry) {
      return {
        storePath,
        sessionKey: params.sessionKey,
        canRestore: true,
        hadEntry: false,
      };
    }
    return {
      storePath,
      sessionKey: params.sessionKey,
      canRestore: true,
      hadEntry: true,
      entry: structuredClone(entry),
    };
  } catch (err) {
    log.debug("boot: could not snapshot session mapping", {
      sessionKey: params.sessionKey,
      error: String(err),
    });
    return {
      storePath,
      sessionKey: params.sessionKey,
      canRestore: false,
      hadEntry: false,
    };
  }
}

async function restoreSessionMapping(
  snapshot: SessionMappingSnapshot,
): Promise<string | undefined> {
  if (!snapshot.canRestore) {
    return undefined;
  }
  try {
    await updateSessionStore(
      snapshot.storePath,
      (store) => {
        if (snapshot.hadEntry && snapshot.entry) {
          store[snapshot.sessionKey] = snapshot.entry;
          return;
        }
        delete store[snapshot.sessionKey];
      },
      { activeSessionKey: snapshot.sessionKey },
    );
    return undefined;
  } catch (err) {
    return formatErrorMessage(err);
  }
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
  const sessionKey = resolveBootSessionKey(mainSessionKey);
  const message = buildBootPrompt(result.content ?? "");
  const sessionId = generateBootSessionId();
  const mappingSnapshot = snapshotSessionMapping({
    cfg: params.cfg,
    sessionKey,
  });

  // Register the boot prompt for the message-tool echo guard so the
  // tool layer can drop fallback-model echoes that copy substantial
  // BOOT.md content without preserving the wrapper markers above.
  // Always cleared in finally so a failed run does not leave a stale
  // entry that mis-fires on an unrelated subsequent run reusing the
  // same session key. Refs #53732.
  setBootEchoContextForSession(sessionKey, message);
  let agentFailure: string | undefined;
  try {
    await agentCommand(
      {
        message,
        sessionKey,
        sessionId,
        deliver: false,
        suppressPromptPersistence: true,
      },
      bootRuntime,
      params.deps,
    );
  } catch (err) {
    agentFailure = formatErrorMessage(err);
    log.error(`boot: agent run failed: ${agentFailure}`);
  } finally {
    clearBootEchoContextForSession(sessionKey);
  }

  const mappingRestoreFailure = await restoreSessionMapping(mappingSnapshot);
  if (mappingRestoreFailure) {
    log.error(`boot: failed to restore session mapping: ${mappingRestoreFailure}`);
  }

  if (!agentFailure && !mappingRestoreFailure) {
    return { status: "ran" };
  }
  const reasonParts = [
    agentFailure ? `agent run failed: ${agentFailure}` : undefined,
    mappingRestoreFailure ? `mapping restore failed: ${mappingRestoreFailure}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return { status: "failed", reason: reasonParts.join("; ") };
}
