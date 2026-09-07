import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import { createHumanMentionPolicy, humanMentionDisplayLabel } from "./human-mention-policy.js";
import {
  MAX_MENTION_SOURCES,
  MENTION_RETENTION_MS,
  readMentionStoreSnapshot,
  writeMentionStoreChanges,
  type MentionStoreHead,
  type MentionStoreMessage,
  type MentionStoreSource,
} from "./mention-inbox-store.js";
import type { MentionCommittedInput, MentionInbox } from "./mention-inbox.types.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionSharingTarget } from "./session-sharing.js";
import { deriveSessionTitle } from "./session-utils-core.js";

const MAX_GLOBAL_ITEMS = 10_000;
const log = createSubsystemLogger("gateway/mentions");

type StoredMention = {
  id: string;
  recipientProfileId: string;
  source: ProcessedSource;
  message: MentionStoreMessage;
};

type ProcessedSource = {
  key: string;
  sequence: number;
  expiresAt: number;
  /** Null retains consumption after dismissal, eviction, or intentional non-delivery. */
  recipients: Map<string, StoredMention | null>;
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

/** Durable sources own retention and replay; each Gateway keeps disposable projection indexes. */
export function createMentionInbox(params: {
  gatewayInstanceId: string;
  getRuntimeConfig: () => OpenClawConfig;
  getClients: () => Iterable<GatewayClient>;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  onMentionCreated?: (notification: MentionNotification) => void;
}): MentionInbox {
  const policy = createHumanMentionPolicy(params);
  const items = new Map<string, StoredMention>();
  const itemsByProfile = new Map<string, Set<StoredMention>>();
  const processed = new Map<string, ProcessedSource>();
  const dirtySources = new Set<string>();
  let head: MentionStoreHead = { revision: -1, nextSequence: 0 };
  const views = new WeakMap<GatewayClient, { signature: string; revision: number }>();
  let active = true;
  let profileVersion = readUserProfileVersion();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let capacityReported = false;
  let profileInvalidationPending = false;
  let nextExpiryAt = Infinity;

  function synchronize(database?: DatabaseSync): boolean {
    const snapshot = readMentionStoreSnapshot(head.revision, database);
    if (!snapshot) {
      return false;
    }
    items.clear();
    itemsByProfile.clear();
    processed.clear();
    dirtySources.clear();
    nextExpiryAt = Infinity;
    for (const stored of snapshot.sources) {
      const source: ProcessedSource = {
        key: stored.key,
        sequence: stored.sequence,
        expiresAt: stored.expiresAt,
        recipients: new Map(),
      };
      processed.set(source.key, source);
      nextExpiryAt = Math.min(nextExpiryAt, source.expiresAt);
      for (const [profileId, id] of stored.recipients) {
        const item: StoredMention | null =
          id && stored.message
            ? { id, recipientProfileId: profileId, source, message: stored.message }
            : null;
        source.recipients.set(profileId, item);
        if (item) {
          items.set(item.id, item);
          indexItem(item, false);
        }
      }
    }
    head = snapshot.head;
    // A restart or another writer may have preceded this process's profile events.
    profileVersion = -1;
    return true;
  }

  function mutate<T>(operation: () => T): T {
    try {
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          synchronize(db);
          expireItems();
          reconcileProfiles();
          const result = operation();
          const changes = new Map<string, MentionStoreSource | undefined>();
          for (const key of dirtySources) {
            const source = processed.get(key);
            if (!source) {
              changes.set(key, undefined);
              continue;
            }
            const message = [...source.recipients.values()].find((item) => item !== null)?.message;
            changes.set(key, {
              key,
              sequence: source.sequence,
              expiresAt: source.expiresAt,
              recipients: [...source.recipients].map(([profileId, item]) => [
                profileId,
                item?.id ?? null,
              ]),
              ...(message ? { message } : {}),
            });
          }
          head = writeMentionStoreChanges(db, head, changes);
          return result;
        },
        {},
        { operationLabel: "mentions.write" },
      );
    } catch (error) {
      // Uncommitted indexes are never published; the next read rebuilds from durable state.
      head = { revision: -1, nextSequence: 0 };
      throw error;
    } finally {
      dirtySources.clear();
    }
  }

  function maintain(): boolean {
    const changed = synchronize();
    const maintenance = Date.now() >= nextExpiryAt || profileVersion !== readUserProfileVersion();
    if (maintenance) {
      mutate(() => undefined);
    }
    return changed || maintenance;
  }

  function removeItem(item: StoredMention | null | undefined): boolean {
    if (!item || !items.delete(item.id)) {
      return false;
    }
    const profileItems = itemsByProfile.get(item.recipientProfileId);
    profileItems?.delete(item);
    if (profileItems?.size === 0) {
      itemsByProfile.delete(item.recipientProfileId);
    }
    item.source.recipients.set(item.recipientProfileId, null);
    dirtySources.add(item.source.key);
    return true;
  }

  function trimItems(
    retained: ReadonlyMap<string, StoredMention> | ReadonlySet<StoredMention>,
    limit: number,
  ) {
    const oldest = retained.values();
    while (retained.size > limit) {
      removeItem(oldest.next().value);
    }
  }

  function indexItem(item: StoredMention, trim = true): void {
    const retained = itemsByProfile.get(item.recipientProfileId) ?? new Set<StoredMention>();
    retained.add(item);
    itemsByProfile.set(item.recipientProfileId, retained);
    if (trim) {
      trimItems(retained, MENTION_INBOX_MAX_ITEMS);
    }
  }

  function expireItems(): boolean {
    const now = Date.now();
    // Retention is bounded, but scanning it on every read and delivery makes a burst quadratic.
    if (now < nextExpiryAt) {
      return false;
    }
    let changed = false;
    let next = Infinity;
    for (const [key, source] of processed) {
      if (source.expiresAt > now) {
        next = Math.min(next, source.expiresAt);
        continue;
      }
      for (const item of source.recipients.values()) {
        changed = removeItem(item) || changed;
      }
      processed.delete(key);
      dirtySources.add(key);
    }
    nextExpiryAt = next;
    if (processed.size < MAX_MENTION_SOURCES) {
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
      const recipients = new Map<string, StoredMention | null>();
      for (const [profileId, item] of source.recipients) {
        const canonical = policy.readProfile(profileId)?.profileId ?? profileId;
        if (canonical !== profileId || recipients.has(canonical)) {
          dirtySources.add(source.key);
        }
        if (!recipients.has(canonical)) {
          recipients.set(canonical, item);
          if (item) {
            item.recipientProfileId = canonical;
          }
          continue;
        }
        const previous = recipients.get(canonical);
        // An acknowledgement remains acknowledged when two aliases become one person.
        if (item === null && previous) {
          items.delete(previous.id);
          recipients.set(canonical, null);
        } else if (item) {
          items.delete(item.id);
        }
      }
      source.recipients = recipients;
    }
    itemsByProfile.clear();
    for (const item of items.values()) {
      // An unresolved display can mean a transient read failure, not a deleted profile.
      // Current authorization hides it; original retention still owns durable deletion.
      indexItem(item);
    }
  }

  function currentTarget(
    item: StoredMention,
    cfg: OpenClawConfig,
    targets?: Map<string, ReturnType<typeof resolveSessionSharingTarget>>,
  ) {
    const { source, message } = item;
    const { agentId, sessionKey, senderProfileId } = message.content;
    if (!active || items.get(item.id) !== item || source.expiresAt <= Date.now()) {
      return undefined;
    }
    const key = JSON.stringify([agentId, sessionKey]);
    let resolved = targets?.get(key);
    if (resolved === undefined) {
      resolved = resolveSessionSharingTarget({
        cfg,
        sessionKey,
        agentId,
      });
      targets?.set(key, resolved);
    }
    if (!resolved || resolved.entry.sessionId !== message.sessionId) {
      return undefined;
    }
    const target = {
      agentId: resolved.agentId,
      sessionKey: resolved.canonicalKey,
      entry: resolved.entry,
    };
    const recipient = policy.recipientProfile(item.recipientProfileId, target, cfg);
    const sender = policy.readProfile(senderProfileId);
    return recipient && recipient.profileId !== sender?.profileId
      ? { target, recipient, sender }
      : undefined;
  }

  function projectItem(
    item: StoredMention,
    current: NonNullable<ReturnType<typeof currentTarget>>,
  ): MentionInboxItem {
    const { content } = item.message;
    return {
      ...content,
      id: item.id,
      expiresAt: item.source.expiresAt,
      senderProfileId: current.sender?.profileId ?? content.senderProfileId,
      senderLabel: humanMentionDisplayLabel(current.sender?.label, content.senderProfileId),
      ...(current.sender ? { senderAvatarUrl: current.sender.avatarUrl } : {}),
      sessionTitle:
        truncateUtf16Safe(
          (deriveSessionTitle(current.target.entry) ?? "Conversation")
            .replace(/[\p{Cc}\p{Cf}]/gu, " ")
            .replace(/\s+/gu, " ")
            .trim(),
          256,
        ) || "Conversation",
    };
  }

  function readView(
    client: GatewayClient | null,
    cfg = params.getRuntimeConfig(),
    remember = true,
  ): Result<MentionsListResult, ErrorShape> {
    const identified = policy.identify(client, cfg);
    if (!identified.ok) {
      return identified;
    }
    const requester = identified.value;
    const visible: MentionInboxItem[] = [];
    const targets = new Map<string, ReturnType<typeof resolveSessionSharingTarget>>();
    const profileItems = itemsByProfile.get(requester.profile.profileId);
    for (const item of [...(profileItems ?? [])].toReversed()) {
      const current = currentTarget(item, cfg, targets);
      if (current && requester.canRead(current.target)) {
        visible.push(projectItem(item, current));
      }
    }
    const signature = createHash("sha256")
      .update(JSON.stringify([requester.profile.profileId, visible]))
      .digest("hex");
    const previous = client && views.get(client);
    const revision = previous ? previous.revision + Number(signature !== previous.signature) : 0;
    if (client && remember) {
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

  function scheduleExpiry(retryAfterMs?: number): void {
    if (expiryTimer || !active || (processed.size === 0 && retryAfterMs === undefined)) {
      return;
    }
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        refresh();
      },
      retryAfterMs ?? Math.max(1, nextExpiryAt - Date.now()),
    );
    expiryTimer.unref?.();
  }

  function refresh(): void {
    if (!active) {
      return;
    }
    try {
      maintain();
      refreshConnectedViews();
      scheduleExpiry();
    } catch {
      log.warn("Unable to refresh the mention Inbox; current reads will retry.");
      // A failed expiry write must not retire cleanup while the Gateway remains alive.
      scheduleExpiry(60_000);
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
        log.warn("The mention Inbox could not read or save its current state. Reconnect to retry.");
      }
    }
    return err(
      errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry.", {
        retryable: true,
      }),
    );
  }

  refresh();

  return {
    mentionable: (...args: Parameters<typeof policy.mentionable>) =>
      readOperation(() => policy.mentionable(...args)),
    validateRecipients: (...args: Parameters<typeof policy.validateRecipients>) =>
      readOperation(() => policy.validateRecipients(...args)),
    list(client: GatewayClient | null): Result<MentionsListResult, ErrorShape> {
      return readOperation(() => {
        if (maintain()) {
          refreshConnectedViews();
        }
        scheduleExpiry();
        return readView(client);
      });
    },
    dismiss(
      client: GatewayClient | null,
      ids: readonly string[],
    ): Result<MentionsListResult, ErrorShape> {
      return readOperation(() => {
        const result = mutate(() => {
          const current = readView(client, params.getRuntimeConfig(), false);
          if (current.ok) {
            const owned = new Set(current.value.items.map((item) => item.id));
            for (const id of ids) {
              if (owned.has(id)) {
                removeItem(items.get(id));
              }
            }
          }
          return current;
        });
        if (!result.ok) {
          return result;
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
        const committed = mutate<StoredMention[]>(() => {
          const cfg = params.getRuntimeConfig();
          const resolved = resolveSessionSharingTarget({
            cfg,
            sessionKey: input.sessionKey,
            agentId: input.agentId,
          });
          if (
            !resolved ||
            resolved.entry.sessionId !== input.sessionId ||
            resolved.entry.incognito === true ||
            isIncognitoSessionKey(resolved.canonicalKey)
          ) {
            log.debug("Skipped mention delivery because its committed session changed.");
            return [];
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
            return [];
          }
          // Never evict consumption early to make room: doing so could re-alert a dismissed message.
          if (processed.size >= MAX_MENTION_SOURCES) {
            if (!capacityReported) {
              log.warn(
                "Mention retention reached its replay budget; new mention alerts are skipped until retained sources expire.",
              );
              capacityReported = true;
            }
            return [];
          }
          const now = Date.now();
          const source: ProcessedSource = {
            key: sourceKey,
            sequence: head.nextSequence++,
            expiresAt: now + MENTION_RETENTION_MS,
            recipients: new Map(),
          };
          processed.set(sourceKey, source);
          dirtySources.add(sourceKey);
          nextExpiryAt = Math.min(nextExpiryAt, source.expiresAt);
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
          // Recipients share immutable message data; consumed sources retain only replay tombstones.
          const message: StoredMention["message"] = {
            sessionId: input.sessionId,
            content: {
              senderProfileId: sender?.profileId ?? input.senderProfileId,
              sessionKey: target.sessionKey,
              agentId: target.agentId,
              messageId: input.messageId,
              createdAt: now,
              ...(excerpt ? { excerpt } : {}),
            },
          };
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
            const item: StoredMention = {
              id: randomUUID(),
              recipientProfileId: recipient.profileId,
              source,
              message,
            };
            items.set(item.id, item);
            source.recipients.set(recipient.profileId, item);
            indexItem(item);
            trimItems(items, MAX_GLOBAL_ITEMS);
            created.push(item);
          }
          if (unavailableRecipients > 0) {
            log.debug(
              `Skipped ${unavailableRecipients} unavailable mention recipients for committed input.`,
            );
          }
          return created;
        });
        refresh();
        if (!params.onMentionCreated) {
          return;
        }
        for (const item of committed) {
          const retained = items.get(item.id);
          const current = retained && currentTarget(retained, params.getRuntimeConfig());
          if (!retained || !current) {
            continue;
          }
          const projected = projectItem(retained, current);
          params.onMentionCreated({
            id: item.id,
            recipientProfileId: current.recipient.profileId,
            sessionKey: projected.sessionKey,
            agentId: projected.agentId,
            senderLabel: projected.senderLabel,
            sessionTitle: projected.sessionTitle,
            isCurrent: () => {
              try {
                if (!active) {
                  return false;
                }
                maintain();
                const latest = items.get(item.id);
                return Boolean(latest && currentTarget(latest, params.getRuntimeConfig()));
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
