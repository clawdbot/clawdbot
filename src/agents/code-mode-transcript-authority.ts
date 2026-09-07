import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { SessionTranscriptWriteScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  readTranscriptMirrorFacts,
  readTranscriptMirrorFactsInTransaction,
} from "../config/sessions/session-accessor.sqlite-transcript-mirror.js";
import { appendExpectedSessionTranscriptTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveCodeModeWaitAdmission } from "./code-mode-state.js";
import type { AgentMessage } from "./runtime/index.js";

type WaitingClaim = {
  assistantTurnId?: string;
  replayId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
};
type WaitingReservation = {
  claim: WaitingClaim;
  identity?: string;
  attach: (message: AgentMessage, identity?: string) => AgentMessage;
  commit: () => void;
};
export type TranscriptPrefixEntry = {
  eventId: string;
  identity: string;
  message: AgentMessage;
  sourceFingerprint?: string;
};
type Source = TranscriptPrefixEntry & {
  fingerprint: string;
  reservation?: WaitingReservation;
};
const authorities = new WeakMap<object, CodeModeTranscriptAuthority>();
const conflict = (reason: string) => ({ kind: "conflict" as const, reason });

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 32);
}

function sourcePayload(message: AgentMessage): AgentMessage {
  const source = structuredClone(message);
  Reflect.deleteProperty(source, "timestamp");
  Reflect.deleteProperty(source, "idempotencyKey");
  Reflect.deleteProperty(source, "__openclaw");
  return source;
}

function sourceFingerprint(message: AgentMessage, supplied?: string): string {
  if (supplied !== undefined && !/^[a-f0-9]{32}$/u.test(supplied)) {
    throw new Error("provider transcript source fingerprint must be exactly 32 hex characters");
  }
  return supplied ?? fingerprint(sourcePayload(message));
}

function storedFingerprint(message: unknown): string | undefined {
  const value = asOptionalRecord(
    Reflect.get(asOptionalRecord(message) ?? {}, "__openclaw"),
  )?.providerSourceFingerprint;
  return typeof value === "string" ? value : undefined;
}

function isAgentMessage(message: unknown): message is AgentMessage {
  const record = asOptionalRecord(message);
  if (!record) {
    return false;
  }
  const content = record.content;
  switch (record.role) {
    case "user":
      return typeof content === "string" || Array.isArray(content);
    case "assistant":
      return Array.isArray(content);
    case "toolResult":
      return (
        Array.isArray(content) &&
        typeof record.toolCallId === "string" &&
        typeof record.toolName === "string" &&
        typeof record.isError === "boolean"
      );
    case "bashExecution":
      return typeof record.command === "string" && typeof record.output === "string";
    case "custom":
      return (
        (typeof content === "string" || Array.isArray(content)) &&
        typeof record.customType === "string"
      );
    case "branchSummary":
    case "compactionSummary":
      return typeof record.summary === "string";
    default:
      return false;
  }
}

function withSourceIdentity(message: AgentMessage, identity: string, proof: string): AgentMessage {
  const metadata = asOptionalRecord(Reflect.get(message, "__openclaw"));
  return {
    ...message,
    idempotencyKey: identity,
    __openclaw: { ...metadata, providerSourceFingerprint: proof },
  };
}

function sameTopology(left: unknown, right: unknown): boolean {
  const stored = asOptionalRecord(left);
  const source = asOptionalRecord(right);
  return (
    stored?.role === source?.role &&
    stored?.toolCallId === source?.toolCallId &&
    stored?.toolName === source?.toolName
  );
}

function waitingIdentity(
  claim: Pick<WaitingClaim, "assistantTurnId" | "replayId" | "toolCallId">,
): string | undefined {
  return claim.assistantTurnId
    ? `code-mode-result:${fingerprint([claim.replayId, claim.assistantTurnId, claim.toolCallId])}`
    : undefined;
}

export function bindCodeModeTranscriptAuthority(
  carrier: object,
  authority: CodeModeTranscriptAuthority,
): void {
  authorities.set(carrier, authority);
}

export function resolveCodeModeTranscriptAuthority(
  carrier: object | undefined,
): CodeModeTranscriptAuthority | undefined {
  return carrier ? authorities.get(carrier) : undefined;
}

export class CodeModeTranscriptAuthority {
  readonly #committed = new Map<string, WaitingClaim>();
  readonly #pending = new Map<string, WaitingClaim>();
  readonly #target: SessionTranscriptWriteScope & { sessionId: string };
  #active = true;

  constructor(target: SessionTranscriptWriteScope & { sessionId: string }) {
    this.#target = Object.freeze({ ...target });
  }

  close(): void {
    this.#active = false;
    this.#pending.clear();
    this.#committed.clear();
  }

  captureWaiting(params: {
    assistantTurnId?: string;
    runId: string;
    toolCallId: string;
    toolName: string;
  }): void {
    this.#assertActive();
    const replayId = resolveCodeModeWaitAdmission(params.runId);
    if (!replayId) {
      throw new Error("code mode waiting result is unavailable or expired");
    }
    const claim = { ...params, replayId };
    this.#committed.delete(params.runId);
    this.#pending.set(params.runId, claim);
  }

  verifyWaiting(runId: string): boolean {
    this.#assertActive();
    const claim = this.#committed.get(runId);
    const replayId = resolveCodeModeWaitAdmission(runId);
    return Boolean(claim && replayId && claim.replayId === replayId);
  }

  reserve(message: AgentMessage): WaitingReservation | undefined {
    this.#assertActive();
    if (message.role !== "toolResult") {
      return undefined;
    }
    const claims = [...this.#pending.values()].filter(
      (candidate) =>
        candidate.toolCallId === message.toolCallId && candidate.toolName === message.toolName,
    );
    if (claims.length === 0) {
      return undefined;
    }
    if (claims.length > 1) {
      throw new Error("code mode waiting result matches multiple active runs");
    }
    const claim = claims[0]!;
    const identity = waitingIdentity(claim);
    return {
      claim,
      identity,
      attach: (candidate, suppliedIdentity) => {
        this.#assertActive();
        if (
          candidate.role !== "toolResult" ||
          candidate.toolCallId !== claim.toolCallId ||
          candidate.toolName !== claim.toolName
        ) {
          throw new Error("code mode waiting result identity changed before commit");
        }
        const commitIdentity = suppliedIdentity ?? identity;
        if (!commitIdentity) {
          throw new Error("code mode waiting result lacks an authoritative turn identity");
        }
        return { ...candidate, idempotencyKey: commitIdentity };
      },
      commit: () => {
        if (this.#active && this.#pending.get(claim.runId) === claim) {
          this.#pending.delete(claim.runId);
          this.#committed.set(claim.runId, claim);
        }
      },
    };
  }

  async commitPrefix(
    params: {
      assertCurrent?: () => void;
      baseAnchor?: TranscriptEntryAnchor;
      entries: readonly TranscriptPrefixEntry[];
      validatePreparedPrefix?: (messages: readonly AgentMessage[]) => boolean;
    },
    prepare: (message: AgentMessage) => AgentMessage | null,
  ) {
    this.#assertActive();
    params.assertCurrent?.();
    const resolved = resolveSqliteTranscriptScope(this.#target);
    const sources: Source[] = params.entries.map((entry) => {
      const reservation = this.reserve(entry.message);
      return {
        ...entry,
        fingerprint: sourceFingerprint(entry.message, entry.sourceFingerprint),
        ...(reservation ? { reservation } : {}),
      };
    });
    const factParams = {
      entryIds: params.baseAnchor ? [params.baseAnchor.entryId] : [],
      idempotencyKeys: sources.map((entry) => entry.identity),
    };
    const facts = readTranscriptMirrorFacts(
      openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
      resolved,
      factParams,
    );
    if (
      params.baseAnchor &&
      !isDeepStrictEqual(facts.anchorsByEntryId.get(params.baseAnchor.entryId), params.baseAnchor)
    ) {
      return conflict("base-anchor-mismatch");
    }
    const replayed: Array<{
      anchor: TranscriptEntryAnchor;
      identity: string;
      message: AgentMessage;
    }> = [];
    let parentId = params.baseAnchor?.entryId;
    let position = params.baseAnchor?.activeMessagePosition;
    for (const entry of sources) {
      const stored = facts.messagesByIdempotencyKey.get(entry.identity);
      const replayedIdentity =
        isAgentMessage(stored) &&
        facts.anchorsByIdempotencyKey.get(entry.identity)?.entryId === entry.eventId &&
        storedFingerprint(stored) === entry.fingerprint &&
        sameTopology(stored, entry.message);
      if (!replayedIdentity) {
        if (facts.existingIdempotencyKeys.has(entry.identity)) {
          return conflict("prefix-mismatch");
        }
        break;
      }
      const anchor = facts.anchorsByIdempotencyKey.get(entry.identity)!;
      if (
        (parentId !== undefined && anchor.effectiveParentId !== parentId) ||
        (position !== undefined && anchor.activeMessagePosition !== position + 1)
      ) {
        return conflict("prefix-topology-mismatch");
      }
      replayed.push({
        anchor,
        identity: entry.identity,
        message: stored,
      });
      parentId = anchor.entryId;
      position = anchor.activeMessagePosition;
    }
    const pending = sources.slice(replayed.length);
    if (pending.some((entry) => facts.existingIdempotencyKeys.has(entry.identity))) {
      return conflict("prefix-gap");
    }
    const tail =
      replayed.at(-1)?.anchor.entryId ?? params.baseAnchor?.entryId ?? facts.activeAppendParentId;
    if (facts.activeAppendParentId !== tail) {
      return conflict("active-branch-drift");
    }
    const prepared = pending.map((entry) => {
      const message = prepare(entry.message);
      if (!message) {
        return undefined;
      }
      const identity = entry.identity;
      const identified = withSourceIdentity(message, identity, entry.fingerprint);
      return {
        ...entry,
        identity,
        message: entry.reservation?.attach(identified, identity) ?? identified,
      };
    });
    params.assertCurrent?.();
    if (prepared.some((entry) => !entry)) {
      return { kind: "suppressed" as const };
    }
    const entries = prepared.filter(
      (entry): entry is NonNullable<(typeof prepared)[number]> => entry !== undefined,
    );
    if (
      params.validatePreparedPrefix &&
      !params.validatePreparedPrefix([
        ...replayed.map((entry) => entry.message),
        ...entries.map((entry) => entry.message),
      ])
    ) {
      return conflict("prepared-prefix-invalid");
    }
    const identities = [
      ...replayed.map((entry) => entry.identity),
      ...entries.map((entry) => entry.identity),
    ];
    if (new Set(identities).size !== identities.length) {
      return conflict("duplicate-identity");
    }
    const turn = await appendExpectedSessionTranscriptTurn(this.#target, {
      atomicGroup: true,
      expectedLifecycleRevision: this.#target.expectedLifecycleRevision,
      expectedSessionId: this.#target.sessionId,
      expectedWriterRunId: this.#target.expectedWriterRunId,
      messages: entries.map((entry, index) => ({
        eventId: entry.eventId,
        idempotencyLookup: "scan",
        message: entry.message,
        parentId: index ? entries[index - 1]!.eventId : tail,
      })),
      sessionFile: resolved.sessionKey,
      touchSessionEntry: entries.length > 0,
      validateBeforeAppend: (database) => {
        this.#assertActive();
        params.assertCurrent?.();
        return isDeepStrictEqual(
          readTranscriptMirrorFactsInTransaction(database, resolved, factParams),
          facts,
        );
      },
    });
    if (turn.rejectedReason === "validation-conflict") {
      return conflict("transaction-drift");
    }
    if (turn.rejectedReason) {
      return { kind: "rejected" as const, reason: turn.rejectedReason };
    }
    if (
      turn.appendedMessages.length !== entries.length ||
      turn.appendedMessages.some(
        (result, index) =>
          result.messageId !== entries[index]!.eventId ||
          storedFingerprint(result.message) !== entries[index]!.fingerprint,
      )
    ) {
      return conflict("commit-mismatch");
    }
    sources.forEach((entry) => entry.reservation?.commit());
    const results = [
      ...replayed.map(({ anchor, identity, message }) => ({ anchor, identity, message })),
      ...turn.appendedMessages.map(({ anchor, message }, index) => ({
        anchor,
        identity: entries[index]!.identity,
        message,
      })),
    ];
    return { kind: entries.length ? ("committed" as const) : ("replayed" as const), results };
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new Error("code mode transcript authority is closed");
    }
  }
}
