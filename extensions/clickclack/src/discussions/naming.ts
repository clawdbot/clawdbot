import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

function shortSessionHash(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 32);
}

function slugifyLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/gu, "");
}

export function fallbackDiscussionLabel(sessionKey: string, agentId?: string): string {
  const agentSegment = agentId?.trim() ? slugifyLabel(agentId) : "";
  const hash = shortSessionHash(sessionKey).slice(0, 8);
  // Channel identity lives in external_ref/channelId; this short name is display-only.
  // resolveAvailableChannelName suffixes collisions instead of relying on a long hash.
  return `s-${agentSegment ? `${agentSegment}-` : ""}${hash}`;
}

export function resolveDiscussionLabel(
  entry: { label?: string; displayName?: string; subject?: string },
  sessionKey: string,
  agentId?: string,
): string {
  // Keep this entry-only prefix aligned with deriveSessionTitle in src/gateway/session-utils-core.ts.
  return (
    entry.label?.trim() ||
    entry.displayName?.trim() ||
    entry.subject?.trim() ||
    fallbackDiscussionLabel(sessionKey, agentId)
  );
}

export function truncateDiscussionDisplayTitle(label: string): string {
  // Mirror the server's normalization (trim after the 200-rune cut) so the
  // display_title equality assertions cannot fail on a whitespace boundary.
  return Array.from(label).slice(0, 200).join("").trim();
}

export function slugifyDiscussionLabel(label: string, sessionKey: string): string {
  const slug = slugifyLabel(label);
  return slug || fallbackDiscussionLabel(sessionKey);
}

type DiscussionBindingIdentity = {
  mainSessionKey: string;
  sessionId: string;
  serverBaseUrl: string;
  channelId: string;
  externalRef: string;
};

function discussionSessionPeerId(identity: DiscussionBindingIdentity): string {
  const digest = createHash("sha256")
    .update(
      [
        identity.mainSessionKey,
        identity.sessionId,
        identity.serverBaseUrl,
        identity.channelId,
        identity.externalRef,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
  return `disc-${digest}`;
}

export function isDiscussionSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(":clickclack:") && /:channel:disc-[0-9a-f]{32}$/u.test(sessionKey);
}

export function discussionExternalRef(
  installationId: string,
  mainSessionKey: string,
  sessionId: string,
  destinationIdentity: string,
  bindingGeneration: string,
): string {
  return `openclaw:${installationId}:${shortSessionHash(
    [mainSessionKey, sessionId, destinationIdentity, bindingGeneration].join("\0"),
  )}`;
}

export function discussionCredentialFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function discussionSessionKey(params: {
  runtime: PluginRuntime;
  agentId: string;
  mainSessionKey: string;
  sessionId: string;
  accountId: string;
  serverBaseUrl: string;
  channelId: string;
  externalRef: string;
}): string | undefined {
  return params.runtime.channel.routing.buildAgentSessionKey({
    agentId: params.agentId,
    channel: "clickclack",
    accountId: params.accountId,
    peer: { kind: "channel", id: discussionSessionPeerId(params) },
  });
}
