import { createHash } from "node:crypto";
import { consumeAdmittedChannelMemoryIdentityFromContext } from "../channels/message-access/memory-identity-admission.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { isMemoryIsolationSubjectAdmitted } from "../plugins/memory-cutover.js";
import {
  ensureMemoryOperationalPrincipal,
  recheckMemoryIdentityBinding,
  recheckMemoryOperationalPrincipal,
  resolveMemoryIdentityBindingFromAdmission,
  type MemoryPrincipalKind,
  type MemoryIdentityBindingCheck,
} from "./memory-identity.js";
import {
  snapshotMemorySessionSubjectInTransaction,
  type MemorySessionSubjectSnapshot,
} from "./memory-session-subject-lifecycle.js";
import {
  isOpenClawAgentDatabaseIncognito,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db.js";
import { AGENT_SESSION_MEMORY_SCHEMA_SQL } from "./openclaw-agent-session-memory-schema.js";

export { snapshotMemorySessionSubjectInTransaction } from "./memory-session-subject-lifecycle.js";
export type { MemorySessionSubjectSnapshot } from "./memory-session-subject-lifecycle.js";

const memorySessionContextBrand: unique symbol = Symbol("openclaw.memory-session-context");
type OperationalSubjectKind = "conversation" | "service" | "agent" | "system";

export type PersistedMemorySessionSubject = Readonly<{
  sessionKey: string;
  subjectRevision: string;
  subject:
    | Readonly<{ kind: "user"; principalId: string; bindingId: string }>
    | Readonly<{
        kind: OperationalSubjectKind;
        principalId: string;
      }>
    | Readonly<{ kind: "ambiguous" }>
    | Readonly<{ kind: "quarantined" }>;
}>;

export type CurrentMemorySessionContext = Readonly<{
  readonly [memorySessionContextBrand]: true;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  /** Immutable generation of the session identity snapshot used by protected-memory plans. */
  sessionIdentityRevision: string;
  subjectRevision: string;
  subject: PersistedMemorySessionSubject["subject"];
  principalId: string;
  bindingId?: string;
  /** Persisted transport identity for a channel/group subject; never a sender identity. */
  conversation?: Readonly<{
    channel: string;
    accountId: string;
    primaryConversationId: string;
  }>;
  authorityRevision: string;
  fingerprint: string;
}>;

export type MemorySessionContextCheck =
  | Readonly<{ kind: "current"; context: CurrentMemorySessionContext }>
  | Readonly<{
      kind:
        | "ambiguous"
        | "session-rebound"
        | "binding-revoked"
        | "principal-revoked"
        | "shadow-subject-mismatch"
        | "merge-head-mismatch";
    }>;

const protectedContexts = new WeakMap<
  object,
  Readonly<{
    sessionKey: string;
    sessionId: string;
    options: OpenClawAgentDatabaseOptions;
  }>
>();
const currentContexts = new WeakSet<object>();

type SubjectRow = {
  session_key: string;
  binding_id: string | null;
  principal_id: string | null;
  subject_kind: string;
  subject_revision: string;
};

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function ensureSchema(database: { db: { exec(sql: string): void } }): void {
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Feature-local additive lazy ensure.
}

function toPersisted(row: SubjectRow): PersistedMemorySessionSubject {
  if (row.subject_kind === "user" && row.binding_id && row.principal_id) {
    return Object.freeze({
      sessionKey: row.session_key,
      subjectRevision: row.subject_revision,
      subject: Object.freeze({
        kind: "user",
        principalId: row.principal_id,
        bindingId: row.binding_id,
      }),
    });
  }
  if (
    (row.subject_kind === "conversation" ||
      row.subject_kind === "service" ||
      row.subject_kind === "agent" ||
      row.subject_kind === "system") &&
    row.principal_id
  ) {
    return Object.freeze({
      sessionKey: row.session_key,
      subjectRevision: row.subject_revision,
      subject: Object.freeze({
        kind: row.subject_kind as OperationalSubjectKind,
        principalId: row.principal_id,
      }),
    });
  }
  return Object.freeze({
    sessionKey: row.session_key,
    subjectRevision: row.subject_revision,
    subject: Object.freeze({
      kind: row.subject_kind === "quarantined" ? "quarantined" : "ambiguous",
    }),
  });
}

function denyForBinding(
  check: MemoryIdentityBindingCheck,
): "binding-revoked" | "merge-head-mismatch" {
  return check.kind === "merge-head-mismatch" ? "merge-head-mismatch" : "binding-revoked";
}

/**
 * Persist exactly one subject for a logical session. An absent, revoked, or
 * unbound binding is explicit ambiguous provenance, never a later inference.
 */
export function persistMemorySessionSubject(params: {
  sessionKey: string;
  sessionId: string;
  bindingId?: string;
  subject?: Readonly<{
    kind: OperationalSubjectKind | "quarantined";
    principalId?: string;
  }>;
  options: OpenClawAgentDatabaseOptions;
}): PersistedMemorySessionSubject {
  const sessionKey = requireText(params.sessionKey, "sessionKey");
  const sessionId = requireText(params.sessionId, "sessionId");
  if (params.bindingId && params.subject) {
    throw new TypeError("a memory subject cannot combine a binding with another principal kind");
  }
  const binding = params.bindingId
    ? recheckMemoryIdentityBinding({ bindingId: params.bindingId, options: params.options })
    : { kind: "unbound" as const };
  const subject = runOpenClawAgentWriteTransaction(
    (database) => {
      ensureSchema(database);
      const mapping = database.db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(sessionKey) as { current_session_id?: string } | undefined;
      if (!mapping || mapping.current_session_id !== sessionId) {
        throw new Error("session-rebound");
      }
      const existing = database.db
        .prepare(
          "SELECT session_key, binding_id, principal_id, subject_kind, subject_revision FROM session_memory_subjects WHERE session_key = ?",
        )
        .get(sessionKey) as SubjectRow | undefined;
      if (existing) {
        return toPersisted(existing);
      }
      const current =
        !isOpenClawAgentDatabaseIncognito(database) && binding.kind === "current"
          ? binding.binding
          : undefined;
      const explicitSubject = isOpenClawAgentDatabaseIncognito(database)
        ? undefined
        : params.subject;
      const subjectKind = current ? "user" : (explicitSubject?.kind ?? "ambiguous");
      const principalId = current?.principalId ?? explicitSubject?.principalId ?? null;
      if (
        (subjectKind === "conversation" ||
          subjectKind === "service" ||
          subjectKind === "agent" ||
          subjectKind === "system") &&
        !principalId
      ) {
        throw new TypeError(`${subjectKind} memory subjects require a principal`);
      }
      const subjectRevision = generateSecureUuid();
      database.db
        .prepare(
          `INSERT INTO session_memory_subjects
           (session_key, binding_id, principal_id, subject_kind, subject_revision, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionKey,
          current?.bindingId ?? null,
          principalId,
          subjectKind,
          subjectRevision,
          Date.now(),
        );
      return toPersisted({
        session_key: sessionKey,
        binding_id: current?.bindingId ?? null,
        principal_id: principalId,
        subject_kind: subjectKind,
        subject_revision: subjectRevision,
      });
    },
    params.options,
    { operationLabel: "memory-session-subject.persist" },
  );
  snapshotMemorySessionSubject({ sessionKey, sessionId, options: params.options });
  return subject;
}

/**
 * Snapshot a logical node's immutable subject for one session-id generation.
 * Lifecycle owners call this in the same transaction that writes session_nodes.
 */
export function snapshotMemorySessionSubject(params: {
  sessionKey: string;
  sessionId: string;
  options: OpenClawAgentDatabaseOptions;
}): MemorySessionSubjectSnapshot | undefined {
  return runOpenClawAgentWriteTransaction(
    (database) => snapshotMemorySessionSubjectInTransaction({ ...params, database }),
    params.options,
    { operationLabel: "memory-session-subject.snapshot" },
  );
}

/** Re-read the session mapping and current binding before each protected operation. */
export function createCurrentMemorySessionContext(params: {
  sessionKey: string;
  sessionId: string;
  options: OpenClawAgentDatabaseOptions;
}): MemorySessionContextCheck {
  const database = openOpenClawAgentDatabase(params.options);
  ensureSchema(database);
  const sessionKey = requireText(params.sessionKey, "sessionKey");
  const sessionId = requireText(params.sessionId, "sessionId");
  const row = database.db
    .prepare(
      `SELECT sn.current_session_id, ms.binding_id, ms.principal_id, ms.subject_kind, ms.subject_revision,
              ss.session_id AS snapshot_session_id, ss.session_key AS snapshot_session_key,
              ss.subject_revision AS snapshot_subject_revision,
              ss.session_identity_revision,
              sw.channel AS conversation_channel, sw.account_id AS conversation_account_id,
              sw.primary_conversation_id
       FROM session_nodes sn
       LEFT JOIN session_memory_subjects ms ON ms.session_key = sn.session_key
       LEFT JOIN session_memory_subject_snapshots ss ON ss.session_id = sn.current_session_id
       LEFT JOIN session_windows sw
         ON sw.session_id = sn.current_session_id AND sw.session_key = sn.session_key
       WHERE sn.session_key = ?`,
    )
    .get(sessionKey) as
    | {
        current_session_id: string;
        binding_id: string | null;
        principal_id: string | null;
        subject_kind: string | null;
        subject_revision: string | null;
        snapshot_session_id: string | null;
        snapshot_session_key: string | null;
        snapshot_subject_revision: string | null;
        session_identity_revision: string | null;
        conversation_channel: string | null;
        conversation_account_id: string | null;
        primary_conversation_id: string | null;
      }
    | undefined;
  if (
    !row ||
    row.current_session_id !== sessionId ||
    row.snapshot_session_id !== sessionId ||
    row.snapshot_session_key !== sessionKey ||
    row.snapshot_subject_revision !== row.subject_revision ||
    !row.session_identity_revision
  ) {
    return { kind: "session-rebound" };
  }
  if (!row.subject_revision) {
    return { kind: "ambiguous" };
  }
  const persisted = toPersisted({
    session_key: sessionKey,
    binding_id: row.binding_id,
    principal_id: row.principal_id,
    subject_kind: row.subject_kind ?? "ambiguous",
    subject_revision: row.subject_revision,
  });
  if (persisted.subject.kind === "ambiguous" || persisted.subject.kind === "quarantined") {
    return { kind: "ambiguous" };
  }
  const conversation =
    persisted.subject.kind === "conversation" &&
    row.conversation_channel &&
    row.conversation_account_id &&
    row.primary_conversation_id
      ? Object.freeze({
          channel: row.conversation_channel,
          accountId: row.conversation_account_id,
          primaryConversationId: row.primary_conversation_id,
        })
      : undefined;
  if (persisted.subject.kind === "conversation" && !conversation) {
    return { kind: "ambiguous" };
  }
  let authorityRevision: string;
  if (persisted.subject.kind === "user") {
    const binding = recheckMemoryIdentityBinding({
      bindingId: persisted.subject.bindingId,
      options: params.options,
    });
    if (
      binding.kind !== "current" ||
      binding.binding.principalId !== persisted.subject.principalId
    ) {
      return { kind: denyForBinding(binding) };
    }
    authorityRevision = binding.binding.revision;
  } else {
    const principal = recheckMemoryOperationalPrincipal({
      principalId: persisted.subject.principalId,
      kind: persisted.subject.kind as Exclude<MemoryPrincipalKind, "user" | "enterprise">,
      options: params.options,
    });
    if (!principal) {
      return { kind: "principal-revoked" };
    }
    authorityRevision = principal.revision;
  }
  if (
    !isMemoryIsolationSubjectAdmitted({
      agentId: params.options.agentId,
      subject: { kind: persisted.subject.kind, principalId: persisted.subject.principalId },
      options: params.options,
    })
  ) {
    return { kind: "shadow-subject-mismatch" };
  }
  const fingerprint = createHash("sha256")
    .update(
      `${params.options.agentId}\u0000${sessionKey}\u0000${sessionId}\u0000${row.subject_revision}\u0000${row.session_identity_revision}\u0000${authorityRevision}`,
    )
    .digest("base64url");
  const context = Object.freeze({
    [memorySessionContextBrand]: true,
    agentId: params.options.agentId,
    sessionKey,
    sessionId,
    sessionIdentityRevision: row.session_identity_revision,
    subjectRevision: row.subject_revision,
    subject: persisted.subject,
    principalId: persisted.subject.principalId,
    ...(persisted.subject.kind === "user" ? { bindingId: persisted.subject.bindingId } : {}),
    ...(conversation ? { conversation } : {}),
    authorityRevision,
    fingerprint,
  }) as CurrentMemorySessionContext;
  currentContexts.add(context);
  return {
    kind: "current",
    context,
  };
}

export function isCurrentMemorySessionContext(
  value: unknown,
): value is CurrentMemorySessionContext {
  return Boolean(value && typeof value === "object" && currentContexts.has(value));
}

/**
 * The inbound session writer is the only consumer of a channel proof. It sees
 * the persisted node mapping, so a route key, context extra, or stale handoff
 * cannot select a different subject or session generation.
 */
export function admitInboundMemorySessionContext(params: {
  context: object;
  sessionKey: string;
  sessionId: string;
  options: OpenClawAgentDatabaseOptions;
}): MemorySessionContextCheck {
  const admission = consumeAdmittedChannelMemoryIdentityFromContext(params.context);
  const inboundSession = readInboundSessionIdentity({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    options: params.options,
  });
  const resolvedBinding =
    admission && inboundSession?.chatType === "direct"
      ? resolveMemoryIdentityBindingFromAdmission({
          admission,
          expectedChannel: inboundSession.channel,
          expectedAccountId: inboundSession.accountId,
          options: params.options,
        })
      : { kind: "unbound" as const };
  // Consume a shared-main proof too. The committed session row, rather than
  // mutable inbound context, decides whether this logical DM is isolated.
  const binding =
    inboundSession?.chatType === "direct" && inboundSession.sessionScope === "conversation"
      ? resolvedBinding
      : { kind: "unbound" as const };
  const conversationSubject =
    binding.kind === "current"
      ? undefined
      : resolveInboundConversationSubject({
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          options: params.options,
        });
  persistMemorySessionSubject({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    ...(binding.kind === "current" ? { bindingId: binding.binding.bindingId } : {}),
    ...(conversationSubject ? { subject: conversationSubject } : {}),
    options: params.options,
  });
  const context = createCurrentMemorySessionContext({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    options: params.options,
  });
  if (context.kind === "current") {
    protectedContexts.set(
      params.context,
      Object.freeze({
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        options: params.options,
      }),
    );
  }
  return context;
}

/** Group/channel identity comes from the persisted transport conversation, never the sender. */
function resolveInboundConversationSubject(params: {
  sessionKey: string;
  sessionId: string;
  options: OpenClawAgentDatabaseOptions;
}): Readonly<{ kind: "conversation"; principalId: string }> | undefined {
  const row = readInboundSessionIdentity(params);
  if (!row?.primaryConversationId || (row.chatType !== "group" && row.chatType !== "channel")) {
    return undefined;
  }
  const principal = ensureMemoryOperationalPrincipal({
    kind: "conversation",
    stableRef: `${params.options.agentId}\u0000${row.primaryConversationId}`,
    options: params.options,
  });
  return Object.freeze({ kind: "conversation", principalId: principal.principalId });
}

function readInboundSessionIdentity(params: {
  sessionKey: string;
  sessionId: string;
  options: OpenClawAgentDatabaseOptions;
}):
  | {
      accountId: string;
      channel: string;
      chatType: "direct" | "group" | "channel";
      sessionScope: "conversation" | "shared-main" | "group" | "channel";
      primaryConversationId: string | null;
    }
  | undefined {
  const row = openOpenClawAgentDatabase(params.options)
    .db.prepare(
      `SELECT account_id, channel, chat_type, session_scope, primary_conversation_id
       FROM session_windows
       WHERE session_id = ? AND session_key = ?`,
    )
    .get(params.sessionId, params.sessionKey) as
    | {
        account_id: string | null;
        channel: string | null;
        chat_type: string | null;
        session_scope: string | null;
        primary_conversation_id: string | null;
      }
    | undefined;
  if (
    !row?.account_id ||
    !row.channel ||
    (row.chat_type !== "direct" && row.chat_type !== "group" && row.chat_type !== "channel") ||
    (row.session_scope !== "conversation" &&
      row.session_scope !== "shared-main" &&
      row.session_scope !== "group" &&
      row.session_scope !== "channel")
  ) {
    return undefined;
  }
  return {
    accountId: row.account_id,
    channel: row.channel,
    chatType: row.chat_type,
    sessionScope: row.session_scope,
    primaryConversationId: row.primary_conversation_id,
  };
}

/** Read the exact frozen context that was created only after the current-authority recheck. */
export function readInboundMemorySessionContext(
  context: object,
): CurrentMemorySessionContext | undefined {
  const source = protectedContexts.get(context);
  if (!source) {
    return undefined;
  }
  const current = createCurrentMemorySessionContext(source);
  return current.kind === "current" ? current.context : undefined;
}
