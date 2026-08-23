import { describe, expect, it } from "vitest";
import { raftPlugin } from "./channel.js";

describe("Raft channel plugin", () => {
  it("declares a wake-only direct channel", () => {
    expect(raftPlugin.meta).toMatchObject({
      id: "raft",
      docsPath: "/channels/raft",
    });
    expect(raftPlugin.capabilities).toEqual({
      chatTypes: ["direct"],
    });
    expect(raftPlugin.message).toBeUndefined();
    expect(raftPlugin.outbound).toBeUndefined();
  });
});
