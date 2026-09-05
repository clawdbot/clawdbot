/**
 * Owner display settings for prompt rendering.
 *
 * Owner ids are rendered raw; no config or secret is required.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

const MAX_OWNER_PROMPT_SENDERS = 16;
export const MAX_OWNER_PROMPT_CONTENT_BYTES = 980;

function exceedsOwnerPromptContentBudget(ownerNumbers: string[]): boolean {
  let bytes = 0;
  for (const ownerId of ownerNumbers) {
    bytes += Buffer.byteLength(ownerId, "utf8") + (bytes > 0 ? 2 : 0);
    if (bytes > MAX_OWNER_PROMPT_CONTENT_BYTES) {
      return true;
    }
  }
  return false;
}

type OwnerDisplaySetting = {
  ownerDisplay?: "raw" | "hash";
  ownerDisplaySecret?: string;
};

type OwnerDisplaySecretResolution = {
  config: OpenClawConfig;
  generatedSecret?: string;
};

/** Keep owner identity guidance bounded without changing the authorization allowlist. */
export function resolveOwnerPromptNumbers(params: {
  ownerNumbers?: string[];
  senderId?: string;
  senderIsOwner?: boolean;
}): string[] | undefined {
  const ownerNumbers = params.ownerNumbers;
  if (!ownerNumbers?.length) {
    return undefined;
  }
  if (
    ownerNumbers.length <= MAX_OWNER_PROMPT_SENDERS &&
    !exceedsOwnerPromptContentBudget(ownerNumbers)
  ) {
    return ownerNumbers;
  }

  const promptOwners = ownerNumbers.slice(0, MAX_OWNER_PROMPT_SENDERS);
  const senderId = params.senderId;
  // Only the already-authenticated, canonical owner may displace another prompt entry.
  if (params.senderIsOwner && senderId && ownerNumbers.includes(senderId)) {
    if (!promptOwners.includes(senderId)) {
      promptOwners[promptOwners.length - 1] = senderId;
    }
    // Reserve the first bytes for the verified owner when long sibling ids exhaust the line.
    if (exceedsOwnerPromptContentBudget(promptOwners) && promptOwners[0] !== senderId) {
      return [senderId, ...promptOwners.filter((ownerId) => ownerId !== senderId)];
    }
  }
  return promptOwners;
}

/**
 * Resolve owner display settings for prompt rendering.
 * Keep auth secrets decoupled from owner hash secrets.
 */
export function resolveOwnerDisplaySetting(_config?: OpenClawConfig): OwnerDisplaySetting {
  return { ownerDisplay: "raw", ownerDisplaySecret: undefined };
}

/**
 * Ensure hash mode has a dedicated secret.
 * Returns updated config and generated secret when autofill was needed.
 */
export function ensureOwnerDisplaySecret(
  config: OpenClawConfig,
  _generateSecret?: () => string,
): OwnerDisplaySecretResolution {
  return { config };
}
