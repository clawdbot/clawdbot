// Browser tests cover CDP committed page-session URL observation.
import { describe, expect, it } from "vitest";
import { prepareCdpTargetSession } from "./cdp-page-session.js";
import type { CdpSendFn } from "./cdp.helpers.js";

describe("prepareCdpTargetSession", () => {
  it("ignores Chrome's transient colon URL while navigation is settling", async () => {
    let frameReadCount = 0;
    const send: CdpSendFn = async (method) => {
      if (method === "Target.attachToTarget") {
        return { sessionId: "SESSION" };
      }
      if (method === "Page.getFrameTree") {
        frameReadCount += 1;
        return {
          frameTree: {
            frame:
              frameReadCount <= 8
                ? { loaderId: "LOADER_TRANSIENT", url: ":" }
                : { loaderId: "LOADER_FINAL", url: "https://example.com/final" },
          },
        };
      }
      return {};
    };

    await expect(
      prepareCdpTargetSession(send, "TARGET", "https://example.com/start"),
    ).resolves.toBe("https://example.com/final");
    expect(frameReadCount).toBeGreaterThan(8);
  });
});
