import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  applySessionPatchProjection,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import { deriveSessionTitle } from "../../gateway/session-utils.js";
import { parseSessionLabel } from "../../sessions/session-label.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const NAME_COMMAND_PREFIX = "/name";

function parseNameCommand(raw: string): { title: string } | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (normalizeOptionalLowercaseString(commandToken) !== NAME_COMMAND_PREFIX) {
    return null;
  }
  const argText = commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim();
  return { title: argText };
}

function nameReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function syncNameSessionEntry(params: HandleCommandsParams): void {
  if (!params.sessionStore || !params.sessionKey || !params.storePath) {
    return;
  }
  const entry = loadSessionEntryReadOnly({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!entry) {
    return;
  }
  params.sessionStore[params.sessionKey] = entry;
  params.sessionEntry = entry;
}

export type NameWriteResult = { ok: true; label: string } | { ok: false; error: string };

/**
 * Applies a validated session label to the current session using the canonical
 * `sessions.patch` projection (same validation and cross-store uniqueness rule
 * as the web/admin path). Shared by `/name` and the named `/new <title>` flow.
 */
export async function writeSessionLabel(
  params: HandleCommandsParams,
  title: string,
  opts?: { expectedSessionId?: string },
): Promise<NameWriteResult> {
  if (!params.storePath || !params.sessionKey) {
    return { ok: false, error: "naming is not available for this session" };
  }
  const storePath = params.storePath;
  const sessionKey = normalizeStoreSessionKey(params.sessionKey);
  const result = await applySessionPatchProjection<{ ok: false; error: string }>({
    storePath,
    resolveTarget: () => ({ primaryKey: sessionKey, candidateKeys: [sessionKey] }),
    project: ({ entries, existingEntry }) => {
      // Native slash may invoke naming before the fast path persists the entry.
      // Seed a copy under the canonical key without mutating params on failed writes.
      const entry = existingEntry ?? (params.sessionEntry ? { ...params.sessionEntry } : undefined);
      if (!entry) {
        return { ok: false, error: "no active session to name" };
      }
      // The caller may bind the write to a specific session incarnation (the one a
      // /new just created). If a concurrent reset rotated the session since, fail
      // instead of relabeling the replacement session.
      if (
        opts?.expectedSessionId !== undefined &&
        entry.sessionId !== undefined &&
        entry.sessionId !== opts.expectedSessionId
      ) {
        return { ok: false, error: "the session changed before it could be named" };
      }
      const validated = parseSessionLabel(title);
      if (!validated.ok) {
        return { ok: false, error: validated.error };
      }
      for (const other of entries) {
        if (other.sessionKey !== sessionKey && other.entry.label === validated.label) {
          return { ok: false, error: `label already in use: ${validated.label}` };
        }
      }
      entry.label = validated.label;
      entry.updatedAt = Math.max(entry.updatedAt ?? 0, Date.now());
      return {
        ok: true,
        entry,
      };
    },
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  syncNameSessionEntry(params);
  const label = result.entry.label;
  if (label === undefined) {
    return { ok: false, error: "failed to persist session label" };
  }
  return { ok: true, label };
}

export const handleNameCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseNameCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/name");
  if (unauthorized) {
    return unauthorized;
  }

  if (!params.storePath || !params.sessionKey) {
    return nameReply("Naming is not available for this session.");
  }

  const title = normalizeOptionalString(parsed.title);

  // No argument: surface the current name plus a deterministic suggestion
  // derived locally (no LLM, no mutation). Apply it with `/name <title>`.
  if (!title) {
    const entry =
      loadSessionEntryReadOnly({ sessionKey: params.sessionKey, storePath: params.storePath }) ??
      params.sessionEntry;
    const current = normalizeOptionalString(entry?.label);
    const suggestionEntry = entry ? { ...entry, label: undefined } : undefined;
    const suggestion = deriveSessionTitle(suggestionEntry);
    const lines: string[] = [];
    lines.push(
      current ? `Current session name: ${current}` : "This session has no custom name yet.",
    );
    if (suggestion && suggestion !== current) {
      lines.push(`Suggested name: ${suggestion}`);
    }
    lines.push("Use /name <title> to set a name (mirrors the session manager).");
    return nameReply(lines.join("\n"));
  }

  const result = await writeSessionLabel(params, title);
  if (!result.ok) {
    return nameReply(`Couldn't rename the session: ${result.error}`);
  }
  markCommandSessionMetadataChanged(params);
  return nameReply(`✅ Session renamed to “${result.label}”.`);
};
