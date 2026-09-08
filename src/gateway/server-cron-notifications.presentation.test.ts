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

import { sendGatewayCronFailureAlert as sendGatewayCronFailureAlertBase } from "./server-cron-notifications.js";

const sendGatewayCronFailureAlert = (
  params: Omit<Parameters<typeof sendGatewayCronFailureAlertBase>[0], "onDeliverySettled">,
) =>
  sendGatewayCronFailureAlertBase({
    ...params,
    onDeliverySettled: async () => {},
  });

describe("sendGatewayCronFailureAlert presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendCronAnnouncePayloadStrict.mockResolvedValue({
      status: "sent",
      results: [],
      receipt: {
        primaryPlatformMessageId: undefined,
        platformMessageIds: [],
        parts: [],
        sentAt: 0,
      },
    });
  });

  it.each([
    {
      name: "without a public origin",
      gateway: undefined,
      expectedText: "cron failed\nRun started: 2026-01-15 10:30 EST",
    },
    {
      name: "with a public origin",
      gateway: {
        publicOrigin: "https://gateway.example",
        controlUi: { basePath: "/control" },
      },
      expectedText:
        "cron failed\nRun started: 2026-01-15 10:30 EST\nInspect: https://gateway.example/control/automations?job=job-1&run=cron%3Ajob-1%3A1768491000000",
    },
  ])(
    "composes failure alert details $name without dropping presentation",
    async ({ gateway, expectedText }) => {
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
          cfg: { agents: { defaults: { userTimezone: "America/New_York" } }, gateway },
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
            text: expectedText,
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
    },
  );
});
