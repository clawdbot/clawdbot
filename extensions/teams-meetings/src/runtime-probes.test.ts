import { describe, expect, it, vi } from "vitest";
import { teamsMeetingsConfig } from "./config.js";
import { testTeamsMeetingListening } from "./runtime-probes.js";
import type { TeamsMeetingsSession } from "./transports/types.js";

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_probe%40thread.v2/0";
type TeamsMeetingsProbeContext = Parameters<typeof testTeamsMeetingListening>[0];

describe("Microsoft Teams meeting runtime probes", () => {
  it.each([
    {
      chrome: { health: { inCall: true }, launched: true },
      description: "Chrome launched without a tracked target",
      shouldRefresh: true,
    },
    {
      chrome: {
        browserTab: { openedByPlugin: false, targetId: "reused-teams-tab" },
        health: { inCall: true },
        launched: false,
      },
      description: "Chrome reused a tracked manual tab",
      shouldRefresh: true,
    },
    {
      chrome: { health: { inCall: true }, launched: false },
      description: "Chrome neither launched nor tracks a target",
      shouldRefresh: false,
    },
  ])("handles listening when $description", async ({ chrome, shouldRefresh }) => {
    const session = {
      agentId: "main",
      chrome,
      id: "teams-listen",
      mode: "transcribe",
      transport: "chrome",
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

    expect(refreshCaptionHealth).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
    if (shouldRefresh) {
      expect(result.manualAction).toEqual({
        reason: "teams-admission-required",
        message: "Waiting",
      });
    } else {
      expect(result.manualAction).toBeUndefined();
      expect(result.listenTimedOut).toBe(false);
    }
  });
});
