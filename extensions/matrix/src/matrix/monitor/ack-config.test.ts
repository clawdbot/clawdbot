import { describe, expect, it } from "vitest";
import { resolveMatrixAckReactionConfig } from "./ack-config.js";

describe("resolveMatrixAckReactionConfig", () => {
  it("prefers account-level ack reaction and scope overrides", () => {
    expect(
      resolveMatrixAckReactionConfig({
        cfg: {
          messages: {
            ackReaction: "👀",
            ackReactionScope: "all",
          },
          channels: {
            matrix: {
              ackReaction: "✅",
              ackReactionScope: "group-all",
              accounts: {
                ops: {
                  ackReaction: "🟢",
                  ackReactionScope: "direct",
                },
              },
            },
          },
        },
        agentId: "ops-agent",
        accountId: "ops",
      }),
    ).toEqual({
      ackReaction: "🟢",
      ackReactionScope: "direct",
    });
  });

  it("falls back to channel then global settings", () => {
    expect(
      resolveMatrixAckReactionConfig({
        cfg: {
          messages: {
            ackReaction: "👀",
            ackReactionScope: "all",
          },
          channels: {
            matrix: {
              ackReaction: "✅",
            },
          },
        },
        agentId: "ops-agent",
        accountId: "missing",
      }),
    ).toEqual({
      ackReaction: "✅",
      ackReactionScope: "all",
    });
  });
});
