// Mattermost test support covers monitor.channel kind plugin behavior.
import { describe, expect, it } from "vitest";
import { mapMattermostChannelTypeToChatType } from "./monitor-auth.js";

describe("mapMattermostChannelTypeToChatType", () => {
  it("maps direct and group dm channel types", () => {
    expect(mapMattermostChannelTypeToChatType("D")).toBe("direct");
    expect(mapMattermostChannelTypeToChatType("g")).toBe("group");
  });

  it("maps private channels to group", () => {
    expect(mapMattermostChannelTypeToChatType("P")).toBe("group");
    expect(mapMattermostChannelTypeToChatType(" p ")).toBe("group");
  });

  it("keeps public channels and unknown typed values as channel", () => {
    expect(mapMattermostChannelTypeToChatType("O")).toBe("channel");
    expect(mapMattermostChannelTypeToChatType("x")).toBe("channel");
  });

  it("treats missing channel type as direct", () => {
    expect(mapMattermostChannelTypeToChatType(undefined)).toBe("direct");
    expect(mapMattermostChannelTypeToChatType(null)).toBe("direct");
    expect(mapMattermostChannelTypeToChatType("")).toBe("direct");
  });
});
