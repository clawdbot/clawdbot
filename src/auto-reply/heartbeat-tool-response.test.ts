import { describe, expect, it } from "vitest";
import {
  createHeartbeatToolResponsePayload,
  resolveHeartbeatScratchProposalFromReplyResult,
} from "./heartbeat-tool-response.js";

describe("heartbeat scratch proposal resolution", () => {
  it("lets a later heartbeat response clear an earlier scratch proposal", () => {
    const first = createHeartbeatToolResponsePayload({
      outcome: "progress",
      notify: false,
      summary: "first",
      scratch: "stale scratch",
    });
    const corrected = createHeartbeatToolResponsePayload({
      outcome: "no_change",
      notify: false,
      summary: "corrected",
    });

    expect(resolveHeartbeatScratchProposalFromReplyResult([first, corrected])).toBeUndefined();
  });
});
