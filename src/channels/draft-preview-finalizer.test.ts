import { describe, expect, it, vi } from "vitest";
import { deliverFinalizableDraftPreview } from "./draft-preview-finalizer.js";

function createDraft(id: string | undefined = "preview-1") {
  return {
    flush: vi.fn(async () => {}),
    id: vi.fn(() => id),
    seal: vi.fn(async () => {}),
    discardPending: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

describe("deliverFinalizableDraftPreview", () => {
  it("does not flush non-finalizable finals before normal delivery", async () => {
    const draft = createDraft("preview-1");
    const deliverNormally = vi.fn(async () => {});

    await deliverFinalizableDraftPreview({
      kind: "final",
      payload: { text: "image", mediaUrl: "https://example.com/a.png" },
      draft,
      buildFinalEdit: () => undefined,
      editFinal: vi.fn(async () => {}),
      deliverNormally,
    });

    expect(draft.flush).not.toHaveBeenCalled();
    expect(draft.discardPending).toHaveBeenCalledTimes(1);
    expect(deliverNormally).toHaveBeenCalledTimes(1);
    expect(draft.clear).toHaveBeenCalledTimes(1);
  });

  it("flushes only eligible finals and edits the preview in place", async () => {
    const draft = createDraft("preview-1");
    const editFinal = vi.fn(async () => {});
    const deliverNormally = vi.fn(async () => {});

    const result = await deliverFinalizableDraftPreview({
      kind: "final",
      payload: { text: "final" },
      draft,
      buildFinalEdit: (payload) => payload.text,
      editFinal,
      deliverNormally,
    });

    expect(result).toBe("preview-finalized");
    expect(draft.flush).toHaveBeenCalledTimes(1);
    expect(draft.seal).toHaveBeenCalledTimes(1);
    expect(editFinal).toHaveBeenCalledWith("preview-1", "final");
    expect(deliverNormally).not.toHaveBeenCalled();
    expect(draft.clear).not.toHaveBeenCalled();
  });

  it("falls back to normal delivery and clears only after success when edit fails", async () => {
    const draft = createDraft("preview-1");
    const editFinal = vi.fn(async () => {
      throw new Error("gone");
    });
    const deliverNormally = vi.fn(async () => {});

    await deliverFinalizableDraftPreview({
      kind: "final",
      payload: { text: "final" },
      draft,
      buildFinalEdit: (payload) => payload.text,
      editFinal,
      deliverNormally,
      logPreviewEditFailure: vi.fn(),
    });

    expect(draft.flush).toHaveBeenCalledTimes(1);
    expect(draft.discardPending).toHaveBeenCalledTimes(1);
    expect(deliverNormally).toHaveBeenCalledTimes(1);
    expect(draft.clear).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing preview if normal fallback delivery throws", async () => {
    const draft = createDraft("preview-1");

    await expect(
      deliverFinalizableDraftPreview({
        kind: "final",
        payload: { text: "image" },
        draft,
        buildFinalEdit: () => undefined,
        editFinal: vi.fn(async () => {}),
        deliverNormally: vi.fn(async () => {
          throw new Error("send failed");
        }),
      }),
    ).rejects.toThrow("send failed");

    expect(draft.discardPending).toHaveBeenCalledTimes(1);
    expect(draft.clear).not.toHaveBeenCalled();
  });
});
