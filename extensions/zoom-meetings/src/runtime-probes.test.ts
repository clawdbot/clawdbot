import { describe, expect, it, vi } from "vitest";
import { zoomMeetingsConfig } from "./config.js";
import { testZoomMeetingListening } from "./runtime-probes.js";
import type { ZoomMeetingsSession } from "./transports/types.js";

const URL = "https://zoom.us/j/12345678902?pwd=probe";
type ZoomMeetingsProbeContext = Parameters<typeof testZoomMeetingListening>[0];

describe("Zoom meeting runtime probes", () => {
  it.each([
    { launched: true, targetId: undefined, shouldWait: false },
    { launched: false, targetId: "manual-zoom-tab", shouldWait: true },
  ])(
    "uses tracked target ownership when launched=$launched and targetId=$targetId",
    async ({ launched, targetId, shouldWait }) => {
      const session = {
        agentId: "main",
        chrome: {
          ...(targetId ? { browserTab: { openedByPlugin: false, targetId } } : {}),
          health: { inCall: true },
          launched,
        },
        id: "zoom-listen",
        mode: "transcribe",
        transport: "chrome",
      } as ZoomMeetingsSession;
      const refreshCaptionHealth = vi.fn(async () => {
        session.chrome!.health = {
          ...session.chrome!.health,
          manualAction: { reason: "zoom-admission-required", message: "Waiting" },
        };
      });
      const context = {
        config: zoomMeetingsConfig.resolveConfig({}),
        hasHealthHandle: () => false,
        isReusable: () => false,
        join: vi.fn(async () => ({ session, spoken: false })),
        list: () => [],
        refreshCaptionHealth,
        refreshHealth: () => {},
        resolveAgentId: () => "main",
      } satisfies ZoomMeetingsProbeContext;

      const result = await testZoomMeetingListening(context, {
        mode: "transcribe",
        timeoutMs: 100,
        url: URL,
      });

      if (shouldWait) {
        expect(refreshCaptionHealth).toHaveBeenCalledOnce();
        expect(result.manualAction).toEqual({
          reason: "zoom-admission-required",
          message: "Waiting",
        });
      } else {
        expect(refreshCaptionHealth).not.toHaveBeenCalled();
      }
    },
  );
});
