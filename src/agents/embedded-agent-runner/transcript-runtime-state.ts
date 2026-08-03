import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptRuntimeReadTarget } from "../../config/sessions/session-accessor.js";

export type RuntimeTranscriptScope = SessionTranscriptRuntimeScope;
type RuntimeTranscriptTarget = SessionTranscriptRuntimeTarget;

/**
 * Resolves the runtime transcript target for read/probe operations without
 * linking missing file-backed metadata into the session store.
 */
export async function resolveRuntimeTranscriptReadTarget(
  scope: RuntimeTranscriptScope,
): Promise<RuntimeTranscriptTarget> {
  return await resolveSessionTranscriptRuntimeReadTarget(scope);
}
