import { describe, expect, it } from "vitest";
import reefEntry from "./index.js";
import { reefPlugin } from "./src/channel.js";
import { reefOutboundAdapter } from "./src/outbound.js";

describe("reef bundled entry", () => {
  it("keeps outbound delivery on the canonical channel plugin", () => {
    expect(reefEntry.loadChannelOutbound).toBeUndefined();
    expect(reefPlugin.outbound).toBe(reefOutboundAdapter);
  });
});
