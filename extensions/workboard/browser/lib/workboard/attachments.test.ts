// @vitest-environment node
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import {
  WORKBOARD_MAX_ATTACHMENT_BYTES,
  WORKBOARD_MAX_CARD_ATTACHMENTS,
  WORKBOARD_MAX_ATTACHMENT_NAME_LENGTH,
  stageWorkboardAttachments,
} from "./attachments.ts";
import {
  deleteWorkboardAttachment,
  inspectWorkboardAttachment,
  removeWorkboardStagedAttachment,
  saveWorkboardCardDraft,
} from "./mutations.ts";
import { getWorkboardState } from "./runtime.ts";
import { createWorkboardCard, createWorkboardTestClient } from "./test/index-helpers.ts";
import type { WorkboardAttachment } from "./types.ts";

function stagedFile(name: string, content = "hello") {
  return new File([content], name, { type: "text/plain" });
}

function cardWithAttachments(count: number) {
  return createWorkboardCard({
    metadata: {
      attachments: Array.from({ length: count }, (_, index) => ({
        id: `attachment-${index}`,
        cardId: "card-1",
        createdAt: index + 1,
        fileName: `file-${index}.txt`,
        byteSize: 1,
        mimeType: "text/plain",
      })),
    },
  });
}

describe("Workboard attachments", () => {
  it("enforces the gateway file and card limits while staging files", () => {
    const oversized = new File(
      [new Uint8Array(WORKBOARD_MAX_ATTACHMENT_BYTES + 1)],
      "oversized.bin",
    );
    const result = stageWorkboardAttachments(
      [oversized, stagedFile("one.txt"), stagedFile("two.txt")],
      0,
    );

    expect(result.accepted.map((entry) => entry.fileName)).toEqual(["one.txt", "two.txt"]);
    expect(result.rejected).toEqual([{ fileName: "oversized.bin", reason: "too_large" }]);

    expect(
      stageWorkboardAttachments([stagedFile("too-many.txt")], WORKBOARD_MAX_CARD_ATTACHMENTS),
    ).toEqual({
      accepted: [],
      rejected: [{ fileName: "too-many.txt", reason: "too_many" }],
    });

    const longName = `${"a".repeat(WORKBOARD_MAX_ATTACHMENT_NAME_LENGTH)}.txt`;
    expect(stageWorkboardAttachments([stagedFile(longName)], 0)).toEqual({
      accepted: [],
      rejected: [{ fileName: longName, reason: "invalid_name" }],
    });
  });

  it("uploads staged files when editing without changing card fields", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const card = cardWithAttachments(0);
    state.cards = [card];
    state.draftOpen = true;
    state.editingCardId = card.id;
    state.editingCardBase = card;
    state.draftTitle = card.title;
    state.draftAttachments = [
      {
        id: "staged-1",
        file: stagedFile("note.txt", "hi"),
        fileName: "note.txt",
        byteSize: 2,
        mimeType: "text/plain",
      },
    ];
    const updated = cardWithAttachments(1);
    const client = createWorkboardTestClient({
      "workboard.cards.attachments.list": { card, attachments: [] },
      "workboard.cards.attachments.add": { card: updated },
    });

    await saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.attachments.add", {
      id: card.id,
      fileName: "note.txt",
      contentBase64: "aGk=",
      mimeType: "text/plain",
    });
    expect(state.cards).toEqual([updated]);
    expect(state.draftAttachments).toEqual([]);
    expect(state.draftOpen).toBe(false);
  });

  it("keeps a transport-failed upload staged without guessing its result", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const card = cardWithAttachments(0);
    state.cards = [card];
    state.draftOpen = true;
    state.editingCardId = card.id;
    state.editingCardBase = card;
    state.draftTitle = card.title;
    const staged = {
      id: "staged-late-commit",
      file: stagedFile("late-commit.txt", "hi"),
      fileName: "late-commit.txt",
      byteSize: 2,
      mimeType: "text/plain",
    };
    state.draftAttachments = [staged];
    const client = createWorkboardTestClient((method) => {
      if (method === "workboard.cards.attachments.list") {
        return { card, attachments: [] };
      }
      if (method === "workboard.cards.attachments.add") {
        throw new Error("gateway transport closed before the add settled");
      }
      return {};
    });

    await saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });

    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.attachments.add"),
    ).toHaveLength(1);
    expect(state.draftAttachments).toEqual([staged]);
    expect(state.error).toContain("upload result is unconfirmed");
    expect(
      client.request.mock.calls.some(([method]) => method === "workboard.cards.attachments.get"),
    ).toBe(false);

    await saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.attachments.add"),
    ).toHaveLength(2);
  });

  it("allows the operator to discard a staged file after an unconfirmed result", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const card = cardWithAttachments(0);
    state.cards = [card];
    state.draftOpen = true;
    state.editingCardId = card.id;
    state.editingCardBase = card;
    state.draftTitle = card.title;
    const staged = {
      id: "staged-ambiguous",
      file: stagedFile("unknown.txt", "hi"),
      fileName: "unknown.txt",
      byteSize: 2,
      mimeType: "text/plain",
    };
    state.draftAttachments = [staged];
    const client = createWorkboardTestClient((method) =>
      method === "workboard.cards.attachments.add"
        ? (() => {
            throw new Error("response lost after commit");
          })()
        : { card, attachments: [] },
    );

    await saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });
    await removeWorkboardStagedAttachment({ host, staged, requestUpdate: vi.fn() });
    expect(state.draftAttachments).toEqual([]);
    expect(client.request).not.toHaveBeenCalledWith(
      "workboard.cards.attachments.get",
      expect.anything(),
    );
  });

  it("uses the authoritative preflight version for non-overlapping field edits", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const base = cardWithAttachments(0);
    const current = createWorkboardCard({
      id: base.id,
      updatedAt: 2,
      metadata: { attachments: cardWithAttachments(1).metadata?.attachments },
    });
    const updated = createWorkboardCard({
      id: base.id,
      title: "Renamed with attachment",
      updatedAt: 3,
      metadata: current.metadata,
    });
    const uploaded = createWorkboardCard({
      id: base.id,
      title: updated.title,
      updatedAt: 4,
      metadata: { attachments: cardWithAttachments(2).metadata?.attachments },
    });
    state.cards = [base];
    state.draftOpen = true;
    state.editingCardId = base.id;
    state.editingCardBase = base;
    state.draftTitle = updated.title;
    state.draftAttachments = [
      {
        id: "staged-preflight",
        file: stagedFile("new.txt", "hi"),
        fileName: "new.txt",
        byteSize: 2,
        mimeType: "text/plain",
      },
    ];
    const client = createWorkboardTestClient((method, params) => {
      if (method === "workboard.cards.attachments.list") {
        return { card: current, attachments: current.metadata?.attachments ?? [] };
      }
      if (method === "workboard.cards.update") {
        expect(params).toEqual({
          id: base.id,
          expectedUpdatedAt: current.updatedAt,
          patch: { title: updated.title },
        });
        return { card: updated };
      }
      if (method === "workboard.cards.attachments.add") {
        return { card: uploaded };
      }
      return {};
    });

    await saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });

    expect(state.cards).toEqual([uploaded]);
    expect(state.draftOpen).toBe(false);
  });

  it("keeps optimistic conflict detection for overlapping edits", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const card = cardWithAttachments(0);
    const committed = createWorkboardCard({
      id: card.id,
      title: "Concurrent title",
      updatedAt: 2,
    });
    state.cards = [card];
    state.draftOpen = true;
    state.editingCardId = card.id;
    state.editingCardBase = card;
    state.draftTitle = "Renamed by me";
    const client = createWorkboardTestClient((method, params) => {
      if (method === "workboard.cards.update") {
        expect(params).toEqual({
          id: card.id,
          expectedUpdatedAt: card.updatedAt,
          patch: { title: "Renamed by me" },
        });
        throw new GatewayProtocolRequestError({
          code: "workboard_conflict",
          message: "Card changed while editing",
          details: { type: "workboard_card_conflict", card: committed },
        });
      }
      return {};
    });

    await saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });

    expect(state.cards).toEqual([committed]);
    expect(state.draftOpen).toBe(true);
    expect(state.draftTitle).toBe("Renamed by me");
    expect(state.error).toContain("unsaved edits remain");
  });

  it("confirms against the authoritative attachment count before a concurrent prune", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const base = cardWithAttachments(19);
    const current = cardWithAttachments(20);
    state.cards = [base];
    state.draftOpen = true;
    state.editingCardId = base.id;
    state.editingCardBase = base;
    state.draftTitle = base.title;
    state.draftAttachments = [
      {
        id: "staged-1",
        file: stagedFile("note.txt", "hi"),
        fileName: "note.txt",
        byteSize: 2,
        mimeType: "text/plain",
      },
    ];
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    const client = createWorkboardTestClient({
      "workboard.cards.attachments.list": {
        card: current,
        attachments: current.metadata?.attachments ?? [],
      },
    });

    try {
      await saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("20 existing attachments"));
    expect(client.request).not.toHaveBeenCalledWith(
      "workboard.cards.attachments.add",
      expect.anything(),
    );
    expect(state.draftAttachments).toHaveLength(1);
  });

  it("locks an attachment save before its authoritative preflight resolves", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const card = cardWithAttachments(0);
    const updated = cardWithAttachments(1);
    state.cards = [card];
    state.draftOpen = true;
    state.editingCardId = card.id;
    state.editingCardBase = card;
    state.draftTitle = card.title;
    state.draftAttachments = [
      {
        id: "staged-1",
        file: stagedFile("note.txt", "hi"),
        fileName: "note.txt",
        byteSize: 2,
        mimeType: "text/plain",
      },
    ];
    let resolveList!: (value: unknown) => void;
    const listResponse = new Promise((resolve) => {
      resolveList = resolve;
    });
    const client = createWorkboardTestClient((method) => {
      if (method === "workboard.cards.attachments.list") {
        return listResponse;
      }
      if (method === "workboard.cards.attachments.add") {
        return { card: updated };
      }
      return {};
    });

    const firstSave = saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });
    expect(state.draftSaving).toBe(true);
    const secondSave = saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.attachments.list"),
    ).toHaveLength(1);

    resolveList({ card, attachments: [] });
    await firstSave;
    await secondSave;

    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.attachments.add"),
    ).toHaveLength(1);
    expect(state.draftSaving).toBe(false);
  });

  it("keeps the latest attachment inspection result when reads finish out of order", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const card = cardWithAttachments(0);
    const first: WorkboardAttachment = {
      id: "attachment-a",
      cardId: card.id,
      createdAt: 2,
      fileName: "first.txt",
      byteSize: 1,
      mimeType: "text/plain",
    };
    const second: WorkboardAttachment = {
      id: "attachment-b",
      cardId: card.id,
      createdAt: 3,
      fileName: "second.txt",
      byteSize: 1,
      mimeType: "text/plain",
    };
    state.cards = [{ ...card, metadata: { attachments: [first, second] } }];
    state.detailCardId = card.id;
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const firstRead = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondRead = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    const client = createWorkboardTestClient((method, params) => {
      if (method !== "workboard.cards.attachments.get") {
        return {};
      }
      return params && typeof params === "object" && "id" in params && params.id === first.id
        ? firstRead
        : secondRead;
    });

    const firstInspection = inspectWorkboardAttachment({
      host,
      client,
      attachment: first,
      requestUpdate: vi.fn(),
    });
    const secondInspection = inspectWorkboardAttachment({
      host,
      client,
      attachment: second,
      requestUpdate: vi.fn(),
    });
    resolveSecond({ contentBase64: "Mg==" });
    await secondInspection;
    resolveFirst({ contentBase64: "MQ==" });
    await firstInspection;

    expect(state.attachmentPreview?.attachment.id).toBe(second.id);
  });

  it("does not publish a stale inspection failure after a newer preview succeeds", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const card = cardWithAttachments(0);
    const first: WorkboardAttachment = {
      id: "attachment-a",
      cardId: card.id,
      createdAt: 2,
      fileName: "first.txt",
      byteSize: 1,
      mimeType: "text/plain",
    };
    const second: WorkboardAttachment = {
      id: "attachment-b",
      cardId: card.id,
      createdAt: 3,
      fileName: "second.txt",
      byteSize: 1,
      mimeType: "text/plain",
    };
    state.cards = [{ ...card, metadata: { attachments: [first, second] } }];
    state.detailCardId = card.id;
    let rejectFirst!: (reason?: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const firstRead = new Promise((_, reject) => {
      rejectFirst = reject;
    });
    const secondRead = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    const client = createWorkboardTestClient((method, params) => {
      if (method !== "workboard.cards.attachments.get") {
        return {};
      }
      return params && typeof params === "object" && "id" in params && params.id === first.id
        ? firstRead
        : secondRead;
    });

    const firstInspection = inspectWorkboardAttachment({
      host,
      client,
      attachment: first,
      requestUpdate: vi.fn(),
    });
    const secondInspection = inspectWorkboardAttachment({
      host,
      client,
      attachment: second,
      requestUpdate: vi.fn(),
    });
    resolveSecond({ contentBase64: "Mg==" });
    await secondInspection;
    rejectFirst(new Error("late first read failed"));
    await firstInspection;

    expect(state.attachmentPreview?.attachment.id).toBe(second.id);
    expect(state.error).toBeNull();
  });

  it("does not publish a preview after the attachment disappears", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const attachment: WorkboardAttachment = {
      id: "attachment-removed-during-read",
      cardId: "card-1",
      createdAt: 2,
      fileName: "removed.txt",
      byteSize: 1,
      mimeType: "text/plain",
    };
    const card = createWorkboardCard({ metadata: { attachments: [attachment] } });
    const updated = createWorkboardCard({ id: card.id });
    state.cards = [card];
    state.detailCardId = card.id;
    let resolveRead!: (value: unknown) => void;
    const read = new Promise((resolve) => {
      resolveRead = resolve;
    });
    const client = createWorkboardTestClient((method) =>
      method === "workboard.cards.attachments.get" ? read : {},
    );

    const inspection = inspectWorkboardAttachment({
      host,
      client,
      attachment,
      requestUpdate: vi.fn(),
    });
    state.cards = [updated];
    resolveRead({ contentBase64: "aA==" });
    await inspection;

    expect(state.attachmentPreview).toBeNull();
  });

  it("does not publish an inspection error after the attachment disappears", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const attachment: WorkboardAttachment = {
      id: "attachment-error-after-remove",
      cardId: "card-1",
      createdAt: 2,
      fileName: "removed.txt",
      byteSize: 1,
      mimeType: "text/plain",
    };
    const card = createWorkboardCard({ metadata: { attachments: [attachment] } });
    const updated = createWorkboardCard({ id: card.id });
    state.cards = [card];
    state.detailCardId = card.id;
    let rejectRead!: (reason?: unknown) => void;
    const read = new Promise((_, reject) => {
      rejectRead = reject;
    });
    const client = createWorkboardTestClient((method) =>
      method === "workboard.cards.attachments.get" ? read : {},
    );

    const inspection = inspectWorkboardAttachment({
      host,
      client,
      attachment,
      requestUpdate: vi.fn(),
    });
    state.cards = [updated];
    rejectRead(new Error("attachment no longer exists"));
    await inspection;

    expect(state.attachmentPreview).toBeNull();
    expect(state.error).toBeNull();
  });

  it("keeps a newer preview request alive while deleting the displayed attachment", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const first: WorkboardAttachment = {
      id: "attachment-delete-preview",
      cardId: "card-1",
      createdAt: 2,
      fileName: "first.txt",
      byteSize: 1,
      mimeType: "text/plain",
    };
    const second: WorkboardAttachment = {
      id: "attachment-new-preview",
      cardId: "card-1",
      createdAt: 3,
      fileName: "second.txt",
      byteSize: 1,
      mimeType: "text/plain",
    };
    const card = createWorkboardCard({ metadata: { attachments: [first, second] } });
    const updated = createWorkboardCard({
      id: card.id,
      metadata: { attachments: [second] },
    });
    state.cards = [card];
    state.detailCardId = card.id;
    state.attachmentPreview = { attachment: first, contentBase64: "MQ==" };
    let resolveDelete!: (value: unknown) => void;
    let resolveRead!: (value: unknown) => void;
    const deleteResponse = new Promise((resolve) => {
      resolveDelete = resolve;
    });
    const readResponse = new Promise((resolve) => {
      resolveRead = resolve;
    });
    const client = createWorkboardTestClient((method, params) => {
      if (method === "workboard.cards.attachments.delete") {
        return deleteResponse;
      }
      if (
        method === "workboard.cards.attachments.get" &&
        params &&
        typeof params === "object" &&
        "id" in params &&
        params.id === second.id
      ) {
        return readResponse;
      }
      return {};
    });

    const deletion = deleteWorkboardAttachment({
      host,
      client,
      cardId: card.id,
      attachmentId: first.id,
      requestUpdate: vi.fn(),
    });
    const inspection = inspectWorkboardAttachment({
      host,
      client,
      attachment: second,
      requestUpdate: vi.fn(),
    });
    resolveDelete({ card: updated });
    await deletion;
    resolveRead({ contentBase64: "Mg==" });
    await inspection;

    expect(state.attachmentPreview?.attachment.id).toBe(second.id);
  });

  it("accepts a deletion that committed before its response was lost", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const attachment: WorkboardAttachment = {
      id: "attachment-1",
      cardId: "card-1",
      createdAt: 2,
      fileName: "note.txt",
      byteSize: 2,
      mimeType: "text/plain",
    };
    const card = createWorkboardCard({ metadata: { attachments: [attachment] } });
    const updated = createWorkboardCard({ id: card.id });
    state.cards = [card];
    state.attachmentPreview = { attachment, contentBase64: "aGk=" };
    const client = createWorkboardTestClient((method) => {
      if (method === "workboard.cards.attachments.delete") {
        throw new Error("response lost after commit");
      }
      if (method === "workboard.cards.attachments.list") {
        return { card: updated, attachments: [] };
      }
      return {};
    });

    await deleteWorkboardAttachment({
      host,
      client,
      cardId: card.id,
      attachmentId: attachment.id,
      requestUpdate: vi.fn(),
    });

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(state.cards).toEqual([updated]);
    expect(state.attachmentPreview).toBeNull();
    expect(state.error).toBeNull();
  });

  it("keeps failed files retryable after a partial create upload", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.draftTitle = "Attach proof";
    state.draftAttachments = [
      {
        id: "staged-1",
        file: stagedFile("first.txt", "one"),
        fileName: "first.txt",
        byteSize: 3,
        mimeType: "text/plain",
      },
      {
        id: "staged-2",
        file: stagedFile("second.txt", "two"),
        fileName: "second.txt",
        byteSize: 3,
        mimeType: "text/plain",
      },
    ];
    const created = createWorkboardCard({ id: "card-created", title: "Attach proof" });
    const first = createWorkboardCard({
      id: created.id,
      title: created.title,
      metadata: {
        attachments: [
          {
            id: "attachment-1",
            cardId: created.id,
            createdAt: 2,
            fileName: "first.txt",
            byteSize: 3,
            mimeType: "text/plain",
          },
        ],
      },
    });
    const client = createWorkboardTestClient((method) => {
      if (method === "workboard.cards.create") {
        return { card: created };
      }
      if (method === "workboard.cards.attachments.add") {
        if (client.request.mock.calls.length > 2) {
          throw new GatewayProtocolRequestError({
            code: "INVALID_REQUEST",
            message: "attachment service unavailable",
          });
        }
        return { card: first };
      }
      if (method === "workboard.cards.attachments.list") {
        return { card: first, attachments: first.metadata?.attachments ?? [] };
      }
      return {};
    });

    await saveWorkboardCardDraft({ host, client, requestUpdate: vi.fn() });

    expect(state.cards).toEqual([first]);
    expect(state.draftOpen).toBe(true);
    expect(state.editingCardId).toBe(created.id);
    expect(state.draftAttachments.map((entry) => entry.fileName)).toEqual(["second.txt"]);
    expect(state.error).toContain('Attachment "second.txt" failed');
  });
});
