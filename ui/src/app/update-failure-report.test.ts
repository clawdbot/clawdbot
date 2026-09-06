/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportUpdateFailure } from "./update-failure-report.ts";

const showConfirmDialog = vi.hoisted(() => vi.fn());

vi.mock("../components/confirm-dialog.ts", () => ({ showConfirmDialog }));

const ready = {
  status: "ready" as const,
  attemptId: "handoff-failed",
  body: "sanitized preview",
  previewDigest: "a".repeat(64),
  title: "Update failure",
};

describe("Control UI update failure report consent", () => {
  beforeEach(() => {
    showConfirmDialog.mockReset();
  });

  it("does not submit when the user cancels the reviewed preview", async () => {
    const request = vi.fn(async () => ready);
    showConfirmDialog.mockResolvedValue(false);

    await expect(
      reportUpdateFailure({
        attemptId: "handoff-failed",
        client: { request } as never,
        isCurrent: () => true,
      }),
    ).resolves.toBeNull();

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "update.report",
      { action: "preview", attemptId: "handoff-failed" },
      { timeoutMs: 105_000 },
    );
  });

  it("submits the reviewed digest after explicit confirmation", async () => {
    const created = {
      status: "created" as const,
      url: "https://github.com/openclaw/openclaw/issues/123",
    };
    const request = vi.fn(async (_method: string, params: { action: string }) =>
      params.action === "preview" ? ready : created,
    );
    showConfirmDialog.mockResolvedValue(true);

    await expect(
      reportUpdateFailure({
        attemptId: "handoff-failed",
        client: { request } as never,
        isCurrent: () => true,
      }),
    ).resolves.toEqual(created);

    expect(request).toHaveBeenLastCalledWith(
      "update.report",
      {
        action: "submit",
        attemptId: "handoff-failed",
        previewDigest: "a".repeat(64),
      },
      { timeoutMs: 105_000 },
    );
  });

  it("does not open or submit a preview after the update identity becomes stale", async () => {
    let current = true;
    const request = vi.fn(async () => {
      current = false;
      return ready;
    });

    await expect(
      reportUpdateFailure({
        attemptId: "handoff-failed",
        client: { request } as never,
        isCurrent: () => current,
      }),
    ).resolves.toBeNull();

    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });
});
