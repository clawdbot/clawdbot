import { describe, expect, it } from "vitest";
import {
  createHeartbeatToolResponsePayload,
  resolveHeartbeatScratchProposalFromReplyResult,
} from "./heartbeat-tool-response.js";
import { copyReplyPayloadMetadata } from "./reply-payload.js";

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

describe("#139088 scratch survives payload spread", () => {
  it("preserves scratch when no spread (sanity)", () => {
    const payload = createHeartbeatToolResponsePayload({
      outcome: "done",
      notify: false,
      summary: "ok",
      scratch: "latest run state".padEnd(2500, " "),
    });
    expect(resolveHeartbeatScratchProposalFromReplyResult(payload)).toBe(
      "latest run state".padEnd(2500, " "),
    );
  });

  it("preserves scratch after object spread + copyReplyPayloadMetadata", () => {
    // Mirrors mergeAttemptToolMediaPayloads, which spreads the payload when
    // merging tool media and re-keys metadata via copyReplyPayloadMetadata.
    const payload = createHeartbeatToolResponsePayload({
      outcome: "done",
      notify: false,
      summary: "ok",
      scratch: "latest run state".padEnd(2500, " "),
    });
    const spread = copyReplyPayloadMetadata(payload, { ...payload, text: payload.text });
    expect(resolveHeartbeatScratchProposalFromReplyResult(spread)).toBe(
      "latest run state".padEnd(2500, " "),
    );
  });
});
