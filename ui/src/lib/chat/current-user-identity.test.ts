// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildLocalUserMessage } from "../../pages/chat/user-message-content.ts";
import { resolveCurrentUserIdentity } from "./current-user-identity.ts";
import { normalizeMessage } from "./message-normalizer.ts";

describe("resolveCurrentUserIdentity", () => {
  it.each([true, false])(
    "keeps proven sender provenance and portrait through local sends (pending=%s)",
    (pending) => {
      const identity = { type: "profile", id: "person" };
      const user = {
        id: "person",
        name: "Person",
        avatarUrl: "/api/users/person/avatar?v=1",
        identity,
      };
      for (const sender of [
        resolveCurrentUserIdentity(null, null, user),
        resolveCurrentUserIdentity(
          { snapshot: { presence: [{ instanceId: "self", user }] } },
          "self",
        ),
      ]) {
        const message = buildLocalUserMessage({
          text: "hello",
          createdAt: 1,
          sender: sender!,
          ...(pending ? { pending: { id: "pending" } } : { runId: "ack" }),
        });
        expect(normalizeMessage(message).sender).toEqual({
          id: "person",
          name: "Person",
          identity,
          profileAvatarUrl: user.avatarUrl,
        });
      }
      const fallback = resolveCurrentUserIdentity(null, null, { ...user, identity: undefined });
      expect(
        normalizeMessage(buildLocalUserMessage({ text: "hello", createdAt: 1, sender: fallback! }))
          .sender,
      ).toEqual({ id: "person", name: "Person" });
    },
  );
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
