// Mattermost test support covers monitor.channel kind plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveMattermostTrustedChatKind } from "./monitor-auth.js";

describe("resolveMattermostTrustedChatKind", () => {
  it("maps direct and group dm channel types", () => {
    expect(resolveMattermostTrustedChatKind({ channelType: "D" })).toBe("direct");
    expect(resolveMattermostTrustedChatKind({ channelType: "g" })).toBe("group");
  });

  it("maps private channels to group", () => {
    expect(resolveMattermostTrustedChatKind({ channelType: "P" })).toBe("group");
    expect(resolveMattermostTrustedChatKind({ channelType: " p " })).toBe("group");
  });

  it("keeps public channels and unknown typed values as channel", () => {
    expect(resolveMattermostTrustedChatKind({ channelType: "O" })).toBe("channel");
    expect(resolveMattermostTrustedChatKind({ channelType: "x" })).toBe("channel");
  });

  it("treats missing channel type as direct", () => {
    expect(resolveMattermostTrustedChatKind({ channelType: undefined })).toBe("direct");
    expect(resolveMattermostTrustedChatKind({ channelType: null })).toBe("direct");
    expect(resolveMattermostTrustedChatKind({ channelType: "" })).toBe("direct");
  });
});
