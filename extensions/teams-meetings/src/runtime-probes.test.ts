import { describe, expect, it, vi } from "vitest";
import { teamsMeetingsConfig } from "./config.js";
import { testTeamsMeetingListening } from "./runtime-probes.js";
import type { TeamsMeetingsSession } from "./transports/types.js";

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_probe%40thread.v2/0";
type TeamsMeetingsProbeContext = Parameters<typeof testTeamsMeetingListening>[0];

describe.each(["chrome", "chrome-node"] as const)(
  "Microsoft Teams %s runtime probes",
  (transport) => {
    it.each([
      {
        name: "waits when Chrome launched without a tracked target",
        chrome: { launched: true },
        refreshCalls: 1,
      },
      {
        name: "waits for a reused manually opened tab",
        chrome: {
          launched: false,
          browserTab: { targetId: "teams-manual-tab", openedByPlugin: false },
        },
        refreshCalls: 1,
      },
      {
        name: "does not wait without a launched browser or tracked tab",
        chrome: { launched: false },
        refreshCalls: 0,
      },
    ])("$name", async ({ chrome, refreshCalls }) => {
      const session = {
        agentId: "main",
        chrome: { health: { inCall: true }, ...chrome },
        id: "teams-listen",
        mode: "transcribe",
        transport,
      } as TeamsMeetingsSession;
      const refreshCaptionHealth = vi.fn(async () => {
        session.chrome!.health = {
          ...session.chrome!.health,
          manualAction: { reason: "teams-admission-required", message: "Waiting" },
        };
      });
      const context = {
        config: teamsMeetingsConfig.resolveConfig({}),
        hasHealthHandle: () => false,
        isReusable: () => false,
        join: vi.fn(async () => ({ session, spoken: false })),
        list: () => [],
        refreshCaptionHealth,
        refreshHealth: () => {},
        resolveAgentId: () => "main",
      } satisfies TeamsMeetingsProbeContext;

      const result = await testTeamsMeetingListening(context, {
        mode: "transcribe",
        timeoutMs: 100,
        url: URL,
      });

      expect(refreshCaptionHealth).toHaveBeenCalledTimes(refreshCalls);
      expect(result.manualAction).toEqual(
        refreshCalls ? { reason: "teams-admission-required", message: "Waiting" } : undefined,
      );
      expect(result.listenTimedOut).toBe(false);
    });
  },
);
