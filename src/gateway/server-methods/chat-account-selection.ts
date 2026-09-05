import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChatAccountSelection } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import {
  isUserModelAuthProfileId,
  parseUserModelAuthProfileId,
} from "../../state/user-model-account-id.js";
import { readUserModelAccountSummary } from "../../state/user-model-accounts.js";
import { getUserProfileDisplay, resolveUserProfileId } from "../../state/user-profiles.js";
import type { ChatMetadataSessionEntry } from "./chat-metadata-contract.js";

/** The session owns this preference; it is not a receipt for the account that served a turn. */
export function resolveChatAccountSelection(params: {
  authStore: AuthProfileStore;
  sessionEntry?: ChatMetadataSessionEntry;
  requesterProfileId?: string;
}): ChatAccountSelection {
  const authProfileId = params.sessionEntry?.authProfileOverride?.trim();
  if (!authProfileId) {
    return { kind: "automatic", label: "Automatic account selection" };
  }
  const source = resolveSessionAuthProfileOverrideSource(params.sessionEntry);
  if (!isUserModelAuthProfileId(authProfileId)) {
    const credential = params.authStore.profiles[authProfileId];
    return {
      kind: "shared",
      authProfileId,
      label: truncateUtf16Safe(
        (credential?.displayName?.trim() || authProfileId).toWellFormed(),
        256,
      ),
      source,
    };
  }
  const personal = params.requesterProfileId
    ? readUserModelAccountSummary({ profileId: params.requesterProfileId, authProfileId })
    : undefined;
  if (personal) {
    return { kind: "personal", authProfileId, label: personal.label, source };
  }
  // Session access permits using its established selection, not inspecting
  // another person's provider identity or discovering a credential locator.
  const locator = parseUserModelAuthProfileId(authProfileId);
  const owner = locator ? resolveUserProfileId(locator.ownerProfileId) : undefined;
  const displayName = owner
    ? getUserProfileDisplay(owner).displayName?.trim().toWellFormed()
    : undefined;
  return {
    kind: "personal",
    label: displayName ? truncateUtf16Safe(`${displayName}'s account`, 256) : "Personal account",
    source,
  };
}
