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
    expect(result.activities[0].state).toBe("Helping humans");
  });

  it("uses custom activity type by default", () => {
    const result = expectPresenceUpdate(resolveDiscordPresenceUpdate({ activity: "test" }));
    expect(result.activities[0].type).toBe(4);
    expect(result.activities[0].name).toBe("Custom Status");
  });

  it("respects explicit activityType", () => {
    const result = expectPresenceUpdate(
      resolveDiscordPresenceUpdate({ activity: "test", activityType: 3 }),
    );
    expect(result.activities[0].type).toBe(3);
    expect(result.activities[0].name).toBe("test");
  });

  it("sets streaming URL for type 1", () => {
    const result = expectPresenceUpdate(
      resolveDiscordPresenceUpdate({
        activity: "Live",
        activityType: 1,
        activityUrl: "https://twitch.tv/test",
      }),
    );
    expect(result.activities[0].url).toBe("https://twitch.tv/test");
  });
});
