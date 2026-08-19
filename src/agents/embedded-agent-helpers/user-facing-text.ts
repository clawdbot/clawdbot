import { renderSanitizedUserFacingText } from "../failover/user-copy.js";
import { sanitizeUserFacingText } from "./sanitize-user-facing-text.js";

/** Compose internal-text stripping with the canonical failover copy renderer. */
export function renderUserFacingText(text: unknown, opts?: { errorContext?: boolean }): string {
  return renderSanitizedUserFacingText(sanitizeUserFacingText(text, opts), opts);
}
