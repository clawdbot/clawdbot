import { randomUUID } from "node:crypto";
import type {
  WorkboardAttachment,
  WorkboardCard,
  WorkboardNotification,
  WorkboardWorkerLog,
} from "@openclaw/workboard-contract";
import type { PersistedWorkboardAttachment } from "./persistence-types.js";
import {
  assertCanMutateClaimedCard,
  capText,
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
} from "./store-card-helpers.js";
import {
  MAX_CARD_ARTIFACTS,
  MAX_CARD_ATTACHMENTS,
  MAX_CARD_NOTIFICATIONS,
  MAX_CARD_PROOF,
  MAX_CARD_WORKER_LOGS,
} from "./store-constants.js";
import { WorkboardCoreStore } from "./store-core.js";
import type {
  WorkboardArtifactInput,
  WorkboardAttachmentInput,
  WorkboardMutationScope,
  WorkboardProofInput,
  WorkboardProtocolViolationInput,
  WorkboardWorkerLogInput,
} from "./store-inputs.js";
import {
  clearDiagnostics,
  normalizeArtifact,
  normalizeAttachmentInput,
  normalizeBoundedString,
  normalizeProofInput,
} from "./store-normalizers.js";

export class WorkboardEnrichmentStore extends WorkboardCoreStore {
  async addProof(
    id: string,
    input: WorkboardProofInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const proof = normalizeProofInput(input, now);
    return await this.updateMetadata(
      id,
      (existing) => {
        assertCanMutateClaimedCard(existing, scope);
        const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
        return {
          ...metadata,
          proof: [...(metadata.proof ?? []), proof].slice(-MAX_CARD_PROOF),
        };
      },
      { preserveProofId: proof.id },
    );
  }

  async addProofWithArtifact(
    id: string,
    proofInput: WorkboardProofInput,
    artifactInput: WorkboardArtifactInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const proof = normalizeProofInput(proofInput, now);
    const artifact = normalizeArtifact({ ...artifactInput, createdAt: now });
    if (!artifact) {
      throw new Error("artifact url or path is required.");
    }
    return await this.updateMetadata(
      id,
      (existing) => {
        assertCanMutateClaimedCard(existing, scope);
        const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
        return {
          ...metadata,
          proof: [...(metadata.proof ?? []), proof].slice(-MAX_CARD_PROOF),
          artifacts: [...(metadata.artifacts ?? []), artifact].slice(-MAX_CARD_ARTIFACTS),
        };
      },
      { preserveProofId: proof.id },
    );
  }

  async addArtifact(
    id: string,
    input: WorkboardArtifactInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const artifact = normalizeArtifact({ ...input, createdAt: Date.now() });
    if (!artifact) {
      throw new Error("artifact url or path is required.");
    }
    return await this.updateMetadata(id, (existing) => {
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
      return {
        ...metadata,
        artifacts: [...(metadata.artifacts ?? []), artifact].slice(-MAX_CARD_ARTIFACTS),
      };
    });
  }

  async addAttachment(
    id: string,
    input: WorkboardAttachmentInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope);
      const now = Date.now();
      const { attachment, contentBase64 } = normalizeAttachmentInput(id, input, now);
      await this.attachmentStore.register(attachment.id, {
        version: 1,
        attachment,
        contentBase64,
      });
      try {
        const updated = await this.updateCard(id, {
          metadata: {
            ...clearDiagnostics(existing.metadata, ["missing_proof"]),
            attachments: [...(existing.metadata?.attachments ?? []), attachment].slice(
              -MAX_CARD_ATTACHMENTS,
            ),
          },
        });
        if (!updated.metadata?.attachments?.some((entry) => entry.id === attachment.id)) {
          await this.attachmentStore.delete(attachment.id);
          throw new Error("attachment metadata was trimmed before it could be indexed.");
        }
        return updated;
      } catch (error) {
        await this.attachmentStore.delete(attachment.id);
        throw error;
      }
    });
  }

  async listAttachments(id: string): Promise<{
    card: WorkboardCard;
    attachments: WorkboardAttachment[];
  }> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return { card, attachments: card.metadata?.attachments ?? [] };
  }

  async getAttachment(id: string): Promise<PersistedWorkboardAttachment | undefined> {
    const attachmentId = id.trim();
    const entry = await this.attachmentStore.lookup(attachmentId);
    return entry?.version === 1 ? entry : undefined;
  }

  async deleteAttachment(
    cardId: string,
    attachmentId: string,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(cardId);
      if (!existing) {
        throw new Error(`card not found: ${cardId}`);
      }
      assertCanMutateClaimedCard(existing, scope);
      const attachments = existing.metadata?.attachments ?? [];
      if (!attachments.some((attachment) => attachment.id === attachmentId)) {
        throw new Error(`attachment not found: ${attachmentId}`);
      }
      await this.attachmentStore.delete(attachmentId);
      return await this.updateCard(cardId, {
        metadata: {
          ...existing.metadata,
          attachments: attachments.filter((attachment) => attachment.id !== attachmentId),
        },
      });
    });
  }

  async addWorkerLog(
    id: string,
    input: WorkboardWorkerLogInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const message = normalizeBoundedString(input.message, undefined, 800, "worker log message");
    if (!message) {
      throw new Error("worker log message is required.");
    }
    const level =
      input.level === "warning" || input.level === "error" || input.level === "info"
        ? input.level
        : "info";
    const sessionKey = normalizeBoundedString(input.sessionKey, undefined, 240, "session key");
    const runId = normalizeBoundedString(input.runId, undefined, 160, "run id");
    const log: WorkboardWorkerLog = {
      id: randomUUID(),
      level,
      message,
      createdAt: now,
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
    };
    return await this.updateMetadata(id, (existing) => {
      assertCanMutateClaimedCard(existing, scope);
      return {
        ...existing.metadata,
        workerLogs: [...(existing.metadata?.workerLogs ?? []), log].slice(-MAX_CARD_WORKER_LOGS),
      };
    });
  }

  async recordProtocolViolation(
    id: string,
    input: WorkboardProtocolViolationInput = {},
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const card = await this.get(id);
      if (!card) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(card, scope);
      const now = Date.now();
      const detail =
        normalizeBoundedString(input.detail, undefined, 800, "protocol violation detail") ??
        "Worker stopped without completing or blocking the card.";
      const sessionKey = normalizeBoundedString(input.sessionKey, undefined, 240, "session key");
      const runId = normalizeBoundedString(input.runId, undefined, 160, "run id");
      const log: WorkboardWorkerLog = {
        id: randomUUID(),
        level: "error",
        message: detail,
        createdAt: now,
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
      };
      const execution =
        card.execution?.status === "running"
          ? { ...card.execution, status: "blocked" as const, updatedAt: now }
          : card.execution;
      const attempts = closeRunningAttempts(card.metadata?.attempts, now, "blocked", detail);
      const notification: WorkboardNotification = {
        id: randomUUID(),
        kind: "failed",
        createdAt: now,
        sequence: this.nextNotificationSequence(now),
        message: capText(detail, 240) ?? "Worker protocol violation.",
        ...(sessionKey || cardSessionKey(card)
          ? { sessionKey: sessionKey ?? cardSessionKey(card) }
          : {}),
        ...(runId || cardRunId(card) ? { runId: runId ?? cardRunId(card) } : {}),
      };
      return await this.updateCard(card.id, {
        status: card.status === "done" ? card.status : "blocked",
        ...(execution ? { execution } : {}),
        metadata: {
          ...card.metadata,
          workerLogs: [...(card.metadata?.workerLogs ?? []), log].slice(-MAX_CARD_WORKER_LOGS),
          workerProtocol: {
            state: "violated",
            updatedAt: now,
            detail,
          },
          claim: undefined,
          ...(attempts ? { attempts } : {}),
          failureCount: (card.metadata?.failureCount ?? 0) + 1,
          notifications: [...(card.metadata?.notifications ?? []), notification].slice(
            -MAX_CARD_NOTIFICATIONS,
          ),
        },
      });
    });
  }
}
