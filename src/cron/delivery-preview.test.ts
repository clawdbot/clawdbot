// Delivery preview tests cover dry-run delivery plan output for cron jobs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";
import type { CronJob } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./isolated-agent/delivery-target.js")>()),
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

const { resolveCronDeliveryPreviews } = await import("./delivery-preview.js");

async function previewForJob(job: CronJob) {
  const previews = await resolveCronDeliveryPreviews({ cfg: {} as never, jobs: [job] });
  return previews[job.id]!;
}

describe("resolveCronDeliveryPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "direct-123",
      mode: "implicit",
    });
  });

  it("prefers sessionTarget session context over creator sessionKey", async () => {
    const job = makeCronJob({
      agentId: "avery",
      sessionTarget: "session:agent:avery:telegram:direct:direct-123",
      sessionKey: "agent:avery:telegram:group:ops:sender:direct-123",
      delivery: undefined,
    });

    const preview = await previewForJob(job);

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "avery",
      expect.objectContaining({
        channel: "last",
        sessionKey: "agent:avery:telegram:direct:direct-123",
        sessionTarget: job.sessionTarget,
      }),
      { dryRun: true },
    );
    expect(preview.detail).toBe(
      "resolved from last, session agent:avery:telegram:direct:direct-123",
    );
  });

  it("does not resolve routes for explicit no-delivery jobs", async () => {
    const job = makeCronJob({
      delivery: { mode: "none" },
      sessionTarget: "isolated",
    });

    const preview = await previewForJob(job);

    expect(preview).toEqual({ label: "not requested", detail: "not requested" });
    expect(mocks.resolveDeliveryTarget).not.toHaveBeenCalled();
  });

  it("previews explicit message-tool targets on no-delivery jobs", async () => {
    const job = makeCronJob({
      agentId: "avery",
      delivery: {
        mode: "none",
        channel: "topicchat",
        to: "room#42",
        threadId: 42,
        accountId: "ops",
      },
      sessionTarget: "isolated",
    });

    const preview = await previewForJob(job);

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "avery",
      expect.objectContaining({
        channel: "topicchat",
        to: "room#42",
        threadId: 42,
        accountId: "ops",
        sessionKey: undefined,
        sessionTarget: "isolated",
      }),
      { dryRun: true },
    );
    expect(preview).toEqual({
      label: "none -> telegram:direct-123",
      detail: "explicit",
    });
  });

  it("previews current-target announce with no external route as a conversation commit", async () => {
    mocks.resolveDeliveryTarget.mockResolvedValueOnce({
      ok: false,
      channel: undefined,
      mode: "implicit",
      error: new Error("Channel is required (no configured channels detected)."),
    });
    const job = makeCronJob({
      sessionTarget: "current",
      sessionKey: "agent:main:dashboard:c5557dcf",
      delivery: undefined,
    });

    const preview = await previewForJob(job);

    expect(preview).toEqual({
      label: "announce -> current session",
      detail: "commits to this conversation (no external channel route)",
    });
  });

  it("keeps unavailable external plugin routes fail-closed", async () => {
    mocks.resolveDeliveryTarget.mockResolvedValueOnce({
      ok: false,
      channel: "unavailable-plugin",
      mode: "implicit",
      error: new Error("Channel plugin unavailable"),
    });
    const job = makeCronJob({
      sessionTarget: "current",
      sessionKey: "agent:main:dashboard:c5557dcf",
      delivery: undefined,
    });

    const preview = await previewForJob(job);

    expect(preview).toEqual({
      label: "announce -> last",
      detail: "last -> no route, will fail-closed: Channel plugin unavailable",
    });
  });

  it("does not describe unresolved no-delivery message-tool targets as fail-closed", async () => {
    mocks.resolveDeliveryTarget.mockResolvedValueOnce({
      ok: false,
      mode: "implicit",
      error: new Error("no route"),
    });
    const job = makeCronJob({
      agentId: "avery",
      delivery: {
        mode: "none",
        threadId: 0,
      },
      sessionTarget: "isolated",
    });

    const preview = await previewForJob(job);

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "avery",
      expect.objectContaining({
        threadId: 0,
        sessionKey: undefined,
        sessionTarget: "isolated",
      }),
      { dryRun: true },
    );
    expect(preview).toEqual({
      label: "none -> last",
      detail: "message tool target unresolved: no route",
    });
  });
});
