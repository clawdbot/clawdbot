import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import { captureSessionRecipientAuthority } from "../../config/sessions/session-accessor.js";
import {
  ContinuationRecipientAuthorityBindingSchema,
  type ContinuationRecipientAuthorityBinding,
  type SessionRecipientAuthority,
} from "../../config/sessions/session-recipient-authority-types.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting-pure.js";

export type ContinuationRecipientAuthorityBindingParseResult =
  | { state: "legacy" }
  | { state: "valid"; binding: ContinuationRecipientAuthorityBinding }
  | { state: "invalid" };

export function parseContinuationRecipientAuthorityBinding(
  value: unknown,
): ContinuationRecipientAuthorityBindingParseResult {
  if (value === undefined) {
    return { state: "legacy" };
  }
  const parsed = ContinuationRecipientAuthorityBindingSchema.safeParse(value);
  return parsed.success ? { state: "valid", binding: parsed.data } : { state: "invalid" };
}

export function captureContinuationRecipientAuthorities(
  sessionKeys: readonly string[],
): ContinuationRecipientAuthorityBinding {
  const defaultAgentId = resolveDefaultAgentId(getRuntimeConfig());
  const recipients = normalizeContinuationTargetKeys(sessionKeys).map((sessionKey) => ({
    sessionKey,
    authority: captureSessionRecipientAuthority({
      agentId: resolveAgentIdFromSessionKey(sessionKey, defaultAgentId),
      sessionKey,
    }),
  }));
  return { version: 1, selection: "selected", recipients };
}

export function createContinuationRecipientAuthorityBinding(params: {
  requesterSessionKey: string;
  targetSessionKey?: string;
  targetSessionKeys?: readonly string[];
  fanoutMode?: "tree" | "all";
}): ContinuationRecipientAuthorityBinding {
  if (params.fanoutMode) {
    return { version: 1, selection: "pending", fanoutMode: params.fanoutMode };
  }
  const explicitTargets = normalizeContinuationTargetKeys([
    ...(params.targetSessionKey ? [params.targetSessionKey] : []),
    ...(params.targetSessionKeys ?? []),
  ]);
  return captureContinuationRecipientAuthorities(
    explicitTargets.length > 0 ? explicitTargets : [params.requesterSessionKey],
  );
}

export function resolveSpawnRecipientAuthorityBinding(params: {
  binding?: ContinuationRecipientAuthorityBinding;
  requesterSessionKey: string;
  targetSessionKey?: string;
  targetSessionKeys?: readonly string[];
  fanoutMode?: "tree" | "all";
  treeSessionKeys?: readonly string[];
}): ContinuationRecipientAuthorityBinding | undefined {
  const parsed = parseContinuationRecipientAuthorityBinding(params.binding);
  if (parsed.state === "invalid") {
    throw new Error("Invalid continuation recipient authority binding before spawn");
  }
  if (parsed.state === "valid") {
    if (parsed.binding.selection === "pending" && parsed.binding.fanoutMode === "tree") {
      return captureContinuationRecipientAuthorities(params.treeSessionKeys ?? []);
    }
    return parsed.binding;
  }
  if (params.fanoutMode === "all") {
    return { version: 1, selection: "pending", fanoutMode: "all" };
  }
  if (params.fanoutMode === "tree") {
    return captureContinuationRecipientAuthorities(params.treeSessionKeys ?? []);
  }
  const targetSessionKey = normalizeContinuationTargetKey(params.targetSessionKey);
  const targetSessionKeys = normalizeContinuationTargetKeys(params.targetSessionKeys);
  if (!targetSessionKey && targetSessionKeys.length === 0) {
    return undefined;
  }
  return captureContinuationRecipientAuthorities([
    ...(targetSessionKey ? [targetSessionKey] : []),
    ...targetSessionKeys,
  ]);
}

export function continuationRecipientAuthorityMap(
  binding: ContinuationRecipientAuthorityBinding,
  targetSessionKeys: readonly string[],
): ReadonlyMap<string, SessionRecipientAuthority> {
  if (binding.selection !== "selected") {
    throw new Error("Continuation recipient authority selection is still pending");
  }
  const authorities = new Map(
    binding.recipients.map((recipient) => [recipient.sessionKey, recipient.authority]),
  );
  for (const sessionKey of targetSessionKeys) {
    if (!authorities.has(sessionKey)) {
      throw new Error(`Continuation recipient authority binding is missing target ${sessionKey}`);
    }
  }
  return authorities;
}
