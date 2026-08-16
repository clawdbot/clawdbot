import { describe, expect, it, vi } from "vitest";
import { teamsMeetingsConfig } from "./config.js";
import { testTeamsMeetingListening } from "./runtime-probes.js";
import type { TeamsMeetingsSession } from "./transports/types.js";

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_probe%40thread.v2/0";
type TeamsMeetingsProbeContext = Parameters<typeof testTeamsMeetingListening>[0];

describe("Microsoft Teams meeting runtime probes", () => {
  it("waits for listening when Chrome launched without a tracked target", async () => {
    const session = {
      agentId: "main",
      chrome: { health: { inCall: true }, launched: true },
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

    expect(refreshCaptionHealth).toHaveBeenCalledOnce();
    expect(result.manualAction).toEqual({
      reason: "teams-admission-required",
      message: "Waiting",
    });
  });
});
