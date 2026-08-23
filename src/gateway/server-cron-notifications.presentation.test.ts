import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";

const mocks = vi.hoisted(() => ({
  sendCronAnnouncePayloadStrict: vi.fn(),
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendCronAnnouncePayloadStrict: mocks.sendCronAnnouncePayloadStrict,
  };
});

import { sendGatewayCronFailureAlert } from "./server-cron-notifications.js";

describe("sendGatewayCronFailureAlert presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendCronAnnouncePayloadStrict.mockResolvedValue(undefined);
  });

  it("adds the run start time without dropping presentation", async () => {
    const job = makeCronJob({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "channel:ops",
      },
    });

    await sendGatewayCronFailureAlert({
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({
        agentId: "main",
        cfg: { agents: { defaults: { userTimezone: "America/New_York" } } },
      }),
      job,
      payload: {
        text: "cron failed",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Log in to Codex",
                  action: { type: "command", command: "/login codex" },
                },
              ],
            },
          ],
        },
      },
      runAtMs: Date.parse("2026-01-15T15:30:00.000Z"),
      channel: "telegram",
      to: "channel:ops",
      mode: "announce",
    });

    expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: "cron failed\nRun started: 2026-01-15 10:30 EST",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Log in to Codex",
                    action: { type: "command", command: "/login codex" },
                  },
                ],
              },
            ],
          },
        },
      }),
    );
  });
});
