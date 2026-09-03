import { createHash, randomUUID } from "node:crypto";
import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  MAX_HUMAN_MENTIONS,
  MENTION_INBOX_MAX_ITEMS,
  errorShape,
  type ErrorShape,
  type MentionInboxItem,
  type MentionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import { createHumanMentionPolicy, humanMentionDisplayLabel } from "./human-mention-policy.js";
import type { MentionCommittedInput, MentionInbox } from "./mention-inbox.types.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionSharingTarget } from "./session-sharing.js";
import { deriveSessionTitle } from "./session-utils-core.js";

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_GLOBAL_ITEMS = 10_000;
const MAX_PROCESSED_SOURCES = 10_000;
const log = createSubsystemLogger("gateway/mentions");

type StoredMention = {
  id: string;
  sourceKey: string;
  recipientProfileId: string;
  senderProfileId: string;
  sessionKey: string;
  agentId: string;
  sessionId: string;
  messageId: string;
  createdAt: number;
  expiresAt: number;
  excerpt?: string;
};

type ProcessedSource = {
  expiresAt: number;
  /** Null retains consumption after dismissal, eviction, or intentional non-delivery. */
  recipients: Map<string, string | null>;
};

type MentionNotification = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel: string;
  sessionTitle: string;
  isCurrent: () => boolean;
};

/** One Gateway lifetime owns temporary mention retention, acknowledgement, and replay suppression. */
export function createMentionInbox(params: {
  gatewayInstanceId: string;
  getRuntimeConfig: () => OpenClawConfig;
  getClients: () => Iterable<GatewayClient>;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  onMentionCreated?: (notification: MentionNotification) => void;
}): MentionInbox {
  const policy = createHumanMentionPolicy(params);
  const items = new Map<string, StoredMention>();
  const itemsByProfile = new Map<string, Set<string>>();
  const processed = new Map<string, ProcessedSource>();
  const views = new WeakMap<GatewayClient, { signature: string; revision: number }>();
  let active = true;
  let profileVersion = readUserProfileVersion();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let capacityReported = false;
  let profileInvalidationPending = false;

  function removeItem(id: string): void {
    const item = items.get(id);
    if (!item) {
      return;
    }
    items.delete(id);
    const canonicalId =
      policy.readProfile(item.recipientProfileId)?.profileId ?? item.recipientProfileId;
    const profileItems = itemsByProfile.get(canonicalId);
    profileItems?.delete(id);
    if (profileItems?.size === 0) {
      itemsByProfile.delete(canonicalId);
    }
    const source = processed.get(item.sourceKey);
    for (const [profileId, retainedId] of source?.recipients ?? []) {
      if (retainedId === id) {
        source?.recipients.set(profileId, null);
      }
    }
  }

  function expireItems(): boolean {
    let changed = false;
    const now = Date.now();
    for (const [key, source] of processed) {
      if (source.expiresAt > now) {
        continue;
      }
      for (const id of source.recipients.values()) {
        if (id && items.has(id)) {
          removeItem(id);
          changed = true;
        }
      }
      processed.delete(key);
    }
    if (processed.size < MAX_PROCESSED_SOURCES) {
      capacityReported = false;
    }
    return changed;
  }

  function reconcileProfiles(): void {
    const version = readUserProfileVersion();
    if (version === profileVersion) {
      return;
    }
    profileVersion = version;
    for (const source of processed.values()) {
      const recipients = new Map<string, string | null>();
      for (const [profileId, id] of source.recipients) {
        const canonical = policy.readProfile(profileId)?.profileId ?? profileId;
        if (!recipients.has(canonical)) {
          recipients.set(canonical, id);
          continue;
        }
        const previous = recipients.get(canonical);
        // An acknowledgement remains acknowledged when two aliases become one person.
        if (id === null && previous) {
          items.delete(previous);
          recipients.set(canonical, null);
        } else if (id) {
          items.delete(id);
        }
      }
      source.recipients = recipients;
    }
    itemsByProfile.clear();
    for (const item of items.values()) {
      const profileId = policy.readProfile(item.recipientProfileId)?.profileId;
      if (!profileId) {
        removeItem(item.id);
        continue;
      }
      const retained = itemsByProfile.get(profileId) ?? new Set<string>();
      retained.add(item.id);
      itemsByProfile.set(profileId, retained);
      if (retained.size > MENTION_INBOX_MAX_ITEMS) {
        const oldest = retained.keys().next().value;
        if (oldest !== undefined) {
          removeItem(oldest);
        }
      }
    }
  }

  function currentTarget(
    item: StoredMention,
    cfg: OpenClawConfig,
    targets?: Map<string, ReturnType<typeof resolveSessionSharingTarget>>,
  ) {
    if (!active || items.get(item.id) !== item || item.expiresAt <= Date.now()) {
      return undefined;
    }
    const key = JSON.stringify([item.agentId, item.sessionKey]);
    let resolved = targets?.get(key);
    if (resolved === undefined) {
      resolved = resolveSessionSharingTarget({
        cfg,
        sessionKey: item.sessionKey,
        agentId: item.agentId,
      });
      targets?.set(key, resolved);
    }
    if (!resolved || resolved.entry.sessionId !== item.sessionId) {
      return undefined;
    }
    const target = {
      agentId: resolved.agentId,
      sessionKey: resolved.canonicalKey,
      entry: resolved.entry,
    };
    const recipient = policy.recipientProfile(item.recipientProfileId, target, cfg);
    const sender = policy.readProfile(item.senderProfileId);
    return recipient && recipient.profileId !== sender?.profileId
      ? { target, recipient, sender }
      : undefined;
  }

  function projectItem(
    item: StoredMention,
    current: NonNullable<ReturnType<typeof currentTarget>>,
  ): MentionInboxItem {
    return {
      id: item.id,
      senderProfileId: current.sender?.profileId ?? item.senderProfileId,
      senderLabel: humanMentionDisplayLabel(current.sender?.label, item.senderProfileId),
      ...(current.sender ? { senderAvatarUrl: current.sender.avatarUrl } : {}),
      sessionKey: item.sessionKey,
      agentId: item.agentId,
      sessionTitle:
        truncateUtf16Safe(
          (deriveSessionTitle(current.target.entry) ?? "Conversation")
            .replace(/[\p{Cc}\p{Cf}]/gu, " ")
            .replace(/\s+/gu, " ")
            .trim(),
          256,
        ) || "Conversation",
      messageId: item.messageId,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    };
  }

  function readView(
    client: GatewayClient | null,
    cfg = params.getRuntimeConfig(),
  ): Result<MentionsListResult, ErrorShape> {
    const identified = policy.identify(client, cfg);
    if (!identified.ok) {
      return identified;
    }
    const requester = identified.value;
    const visible: MentionInboxItem[] = [];
    const targets = new Map<string, ReturnType<typeof resolveSessionSharingTarget>>();
    const profileItems = itemsByProfile.get(requester.profile.profileId);
    for (const id of [...(profileItems ?? [])].toReversed()) {
      const item = items.get(id);
      if (!item) {
        continue;
      }
      const current = currentTarget(item, cfg, targets);
      if (current && policy.canRead(requester.client, current.target, cfg)) {
        visible.push(projectItem(item, current));
      }
    }
    const signature = createHash("sha256")
      .update(JSON.stringify([requester.profile.profileId, visible]))
      .digest("hex");
    const previous = client && views.get(client);
    const revision = previous ? previous.revision + Number(signature !== previous.signature) : 0;
    if (client) {
      views.set(client, { signature, revision });
    }
    return ok({ gatewayInstanceId: params.gatewayInstanceId, revision, items: visible });
  }

  function refreshConnectedViews(): void {
    const cfg = params.getRuntimeConfig();
    for (const client of params.getClients()) {
      if (!client.connId) {
        continue;
      }
      const previous = views.get(client);
      const result = readView(client, cfg);
      if (
        !result.ok ||
        (previous ? previous.revision === result.value.revision : result.value.items.length === 0)
      ) {
        continue;
      }
      params.broadcastToConnIds(
        "mentions.changed",
        { gatewayInstanceId: params.gatewayInstanceId, revision: result.value.revision },
        new Set([client.connId]),
      );
    }
  }

  function scheduleExpiry(): void {
    if (expiryTimer || processed.size === 0 || !active) {
      return;
    }
    const expiry = Math.min(...[...processed.values()].map((source) => source.expiresAt));
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        refresh();
      },
      Math.max(1, expiry - Date.now()),
    );
    expiryTimer.unref?.();
  }

  function refresh(): void {
    if (!active) {
      return;
    }
    try {
      expireItems();
      reconcileProfiles();
      refreshConnectedViews();
      scheduleExpiry();
    } catch {
      log.warn("Unable to refresh the temporary mention Inbox; current reads will retry.");
    }
  }

  function invalidate(): void {
    policy.invalidateDirectory();
    refresh();
  }

  // Profile writes publish after commit. The microtask also follows role-policy cache invalidation.
  const stopProfiles = onUserProfilesChanged(() => {
    if (profileInvalidationPending) {
      return;
    }
    profileInvalidationPending = true;
    queueMicrotask(() => {
      profileInvalidationPending = false;
      invalidate();
    });
  });
  const stopSessions = onSessionIdentityMutation(() => invalidate());

  function readOperation<T>(operation: () => Result<T, ErrorShape>): Result<T, ErrorShape> {
    if (active) {
      try {
        return operation();
      } catch {
        log.warn("The temporary mention Inbox could not read its current authorization.");
      }
    }
    return err(
      errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry.", {
        retryable: true,
      }),
    );
  }

  return {
    mentionable: (...args: Parameters<typeof policy.mentionable>) =>
      readOperation(() => policy.mentionable(...args)),
    validateRecipients: (...args: Parameters<typeof policy.validateRecipients>) =>
      readOperation(() => policy.validateRecipients(...args)),
    list(client: GatewayClient | null): Result<MentionsListResult, ErrorShape> {
      return readOperation(() => {
        reconcileProfiles();
        if (expireItems()) {
          refreshConnectedViews();
        }
        return readView(client);
      });
    },
    dismiss(
      client: GatewayClient | null,
      ids: readonly string[],
    ): Result<MentionsListResult, ErrorShape> {
      return readOperation(() => {
        reconcileProfiles();
        expireItems();
        const current = readView(client);
        if (!current.ok) {
          return current;
        }
        const owned = new Set(current.value.items.map((item) => item.id));
        for (const id of ids) {
          if (owned.has(id)) {
            removeItem(id);
          }
        }
        refresh();
        return readView(client);
      });
    },
    recordCommittedInput(input: MentionCommittedInput): void {
      try {
        if (!active || input.recipientProfileIds.length === 0) {
          return;
        }
        const references = [
          input.sourceId,
          input.sessionId,
          input.messageId,
          input.senderProfileId,
          ...input.recipientProfileIds,
        ];
        if (
          input.recipientProfileIds.length > MAX_HUMAN_MENTIONS ||
          input.sessionKey.length > 512 ||
          references.some((value) => !value || value.length > 256)
        ) {
          log.warn("Skipped mention delivery with invalid committed references.");
          return;
        }
        expireItems();
        reconcileProfiles();
        const cfg = params.getRuntimeConfig();
        const resolved = resolveSessionSharingTarget({
          cfg,
          sessionKey: input.sessionKey,
          agentId: input.agentId,
        });
        if (!resolved || resolved.entry.sessionId !== input.sessionId) {
          log.debug("Skipped mention delivery because its committed session changed.");
          return;
        }
        const sourceKey = createHash("sha256")
          .update(
            JSON.stringify([
              resolved.agentId,
              resolved.canonicalKey,
              input.sessionId,
              input.sourceId,
            ]),
          )
          .digest("hex");
        if (processed.has(sourceKey)) {
          return;
        }
        // Never evict consumption early to make room: doing so could re-alert a dismissed message.
        if (processed.size >= MAX_PROCESSED_SOURCES) {
          if (!capacityReported) {
            log.warn(
              "Temporary mention retention reached its replay budget; new mention alerts are skipped until retained sources expire.",
            );
            capacityReported = true;
          }
          return;
        }
        const now = Date.now();
        const source: ProcessedSource = { expiresAt: now + RETENTION_MS, recipients: new Map() };
        processed.set(sourceKey, source);
        const sender = policy.readProfile(input.senderProfileId);
        const target = {
          agentId: resolved.agentId,
          sessionKey: resolved.canonicalKey,
          entry: resolved.entry,
        };
        const excerpt = input.excerpt
          ? truncateUtf16Safe(
              flattenMarkdownToPlainText(truncateUtf16Safe(input.excerpt, 2_048))
                .replace(/[\p{Cc}\p{Cf}]/gu, " ")
                .replace(/\s+/gu, " ")
                .trim(),
              280,
            )
          : undefined;
        const created: StoredMention[] = [];
        let unavailableRecipients = 0;
        for (const profileId of input.recipientProfileIds) {
          const recipient = policy.recipientProfile(profileId, target, cfg);
          const canonicalId = recipient?.profileId ?? profileId;
          if (source.recipients.has(canonicalId)) {
            continue;
          }
          source.recipients.set(canonicalId, null);
          if (!sender || !recipient || sender.profileId === recipient.profileId) {
            unavailableRecipients += 1;
            continue;
          }
          const retained = itemsByProfile.get(recipient.profileId) ?? new Set<string>();
          while (retained.size >= MENTION_INBOX_MAX_ITEMS) {
            const oldest = retained.keys().next().value;
            if (oldest !== undefined) {
              removeItem(oldest);
            }
          }
          while (items.size >= MAX_GLOBAL_ITEMS) {
            const oldest = items.keys().next().value;
            if (oldest !== undefined) {
              removeItem(oldest);
            }
          }
          const item: StoredMention = {
            id: randomUUID(),
            sourceKey,
            recipientProfileId: recipient.profileId,
            senderProfileId: sender.profileId,
            sessionKey: target.sessionKey,
            agentId: target.agentId,
            sessionId: input.sessionId,
            messageId: input.messageId,
            createdAt: now,
            expiresAt: source.expiresAt,
            ...(excerpt ? { excerpt } : {}),
          };
          items.set(item.id, item);
          retained.add(item.id);
          itemsByProfile.set(recipient.profileId, retained);
          source.recipients.set(recipient.profileId, item.id);
          created.push(item);
        }
        if (unavailableRecipients > 0) {
          log.debug(
            `Skipped ${unavailableRecipients} unavailable mention recipients for committed input.`,
          );
        }
        refresh();
        if (!params.onMentionCreated) {
          return;
        }
        for (const item of created) {
          const current = currentTarget(item, params.getRuntimeConfig());
          if (!current) {
            continue;
          }
          const projected = projectItem(item, current);
          params.onMentionCreated({
            id: item.id,
            recipientProfileId: current.recipient.profileId,
            sessionKey: item.sessionKey,
            agentId: item.agentId,
            senderLabel: projected.senderLabel,
            sessionTitle: projected.sessionTitle,
            isCurrent: () => {
              try {
                return Boolean(currentTarget(item, params.getRuntimeConfig()));
              } catch {
                return false;
              }
            },
          });
        }
      } catch {
        log.warn("Mention delivery could not be completed; the posted message is unchanged.");
      }
    },
    invalidate,
    dispose(): void {
      active = false;
      stopProfiles();
      stopSessions();
      policy.dispose();
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = undefined;
      }
      items.clear();
      itemsByProfile.clear();
      processed.clear();
    },
  };
}
