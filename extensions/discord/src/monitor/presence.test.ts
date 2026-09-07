// Discord tests cover presence plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { resolveDiscordPresenceUpdate } from "./presence.js";

type DiscordPresenceUpdate = NonNullable<ReturnType<typeof resolveDiscordPresenceUpdate>>;

function expectPresenceUpdate(
  result: ReturnType<typeof resolveDiscordPresenceUpdate>,
): DiscordPresenceUpdate {
  if (result === null) {
    throw new Error("Expected Discord presence update");
  }
  expect(Array.isArray(result.activities)).toBe(true);
  return result;
}

function expectActivity(result: DiscordPresenceUpdate) {
  return expectDefined(result.activities[0], "Discord presence activity");
}

describe("resolveDiscordPresenceUpdate", () => {
  it("returns online presence when no config is provided", () => {
    const result = expectPresenceUpdate(resolveDiscordPresenceUpdate({}));
    expect(result.status).toBe("online");
    expect(result.activities).toStrictEqual([]);
  });

  it("uses configured status", () => {
    const result = expectPresenceUpdate(resolveDiscordPresenceUpdate({ status: "dnd" }));
    expect(result.status).toBe("dnd");
  });

  it("includes activity when configured", () => {
    const result = expectPresenceUpdate(
      resolveDiscordPresenceUpdate({ activity: "Helping humans" }),
    );
    expect(result.status).toBe("online");
    expect(result.activities).toHaveLength(1);
    expect(expectActivity(result).state).toBe("Helping humans");
  });

  it("uses custom activity type by default", () => {
    const result = expectPresenceUpdate(resolveDiscordPresenceUpdate({ activity: "test" }));
    expect(expectActivity(result).type).toBe(4);
    expect(expectActivity(result).name).toBe("Custom Status");
  });

  it("respects explicit activityType", () => {
    const result = expectPresenceUpdate(
      resolveDiscordPresenceUpdate({ activity: "test", activityType: 3 }),
    );
    expect(expectActivity(result).type).toBe(3);
    expect(expectActivity(result).name).toBe("test");
  });

  it("sets streaming URL for type 1", () => {
    const result = expectPresenceUpdate(
      resolveDiscordPresenceUpdate({
        activity: "Live",
        activityType: 1,
        activityUrl: "https://twitch.tv/test",
      }),
    );
    expect(expectActivity(result).url).toBe("https://twitch.tv/test");
  });
});
