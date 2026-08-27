// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveCurrentUserIdentity } from "./current-user-identity.ts";

describe("resolveCurrentUserIdentity", () => {
  it("selects only this browser connection's presence identity", () => {
    const hello = {
      snapshot: {
        presence: [
          { instanceId: "other-browser", user: { id: "other@example.com" } },
          {
            instanceId: "this-browser",
            user: {
              id: "alice@example.com",
              name: "Alice Example",
              avatarUrl: "/avatars/alice.png",
            },
          },
        ],
      },
    };

    expect(resolveCurrentUserIdentity(hello, "this-browser")).toEqual({
      id: "alice@example.com",
      name: "Alice Example",
      profileAvatarUrl: "/avatars/alice.png",
    });
    expect(resolveCurrentUserIdentity(hello, "missing-browser")).toBeNull();
    expect(
      resolveCurrentUserIdentity(hello, "missing-browser", {
        id: "alice@example.com",
        name: "Updated Alice",
        avatarUrl: "/avatars/alice-v2.png",
      }),
    ).toEqual({
      id: "alice@example.com",
      name: "Updated Alice",
      profileAvatarUrl: "/avatars/alice-v2.png",
    });
  });
});
