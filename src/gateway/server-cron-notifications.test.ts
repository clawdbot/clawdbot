import { describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronJob } from "../cron/types.js";
import { dispatchGatewayCronFinishedNotifications } from "./server-cron-notifications.js";

describe("dispatchGatewayCronFinishedNotifications", () => {
  it("redacts invalid completion webhook targets in warnings", () => {
    const logger = {
      warn: vi.fn(),
    };
    const job = {
      id: "cron-redact",
      name: "redact",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "ftp://user:secret@example.invalid/hook?token=secret",
        },
      },
      state: {},
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok" },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        jobId: "cron-redact",
        deliveryTo: "ftp://example.invalid/hook",
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
  });
});
