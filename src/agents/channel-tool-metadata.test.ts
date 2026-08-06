import { describe, expect, it } from "vitest";
import {
  copyChannelAgentToolMeta,
  getChannelAgentToolMeta,
  setChannelAgentToolMeta,
} from "./channel-tool-metadata.js";

describe("channel tool metadata", () => {
  it("preserves ownership when a concrete tool is wrapped", () => {
    const source = {};
    const wrapped = {};

    setChannelAgentToolMeta(source as never, { channelId: "telegram" });
    copyChannelAgentToolMeta(source as never, wrapped as never);

    expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
  });
});
