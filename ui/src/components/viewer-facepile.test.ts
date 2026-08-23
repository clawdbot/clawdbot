/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAvatarInitials, setAvatarGatewayOrigin } from "../lib/identity-avatar.ts";
import {
  hasMultiplePresenceIdentities,
  hasSessionPresenceViewers,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import { renderChatAuthorAvatar } from "../pages/chat/components/chat-author-avatar.ts";
import "./viewer-facepile.ts";

type ViewerAvatarElement = HTMLElement & {
  user: PresenceViewer | null;
  updateComplete: Promise<boolean>;
};

afterEach(() => {
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

it("uses the same user initials and identity hue in the roster and attributed chat", async () => {
  const user: PresenceViewer = {
    id: "profile-riley",
    name: "Riley",
    email: "riley@example.test",
    watchedSessions: [],
  };
  const viewerAvatar = document.createElement("openclaw-viewer-avatar") as ViewerAvatarElement;
  viewerAvatar.user = user;
  document.body.append(viewerAvatar);

  const chat = document.createElement("div");
  document.body.append(chat);
  render(renderChatAuthorAvatar({ id: user.id, name: user.name, username: user.email }), chat);

  const expected = resolveAvatarInitials({
    id: user.id,
    name: user.name,
    username: user.email,
  });
  await vi.waitFor(async () => {
    await viewerAvatar.updateComplete;
    const rosterInitials = viewerAvatar.querySelector(".viewer-avatar > span");
    const chatInitials = chat.querySelector(".chat-author-avatar__initials");
    expect(rosterInitials?.textContent?.trim()).toBe(expected.initials);
    expect(chatInitials?.textContent?.trim()).toBe(expected.initials);
    expect(rosterInitials?.getAttribute("style")).toContain(
      `hsl(${expected.colorSeed % 360} 48% 42%)`,
    );
    expect(chatInitials?.getAttribute("style")).toContain(
      `--chat-author-avatar-hue: ${expected.colorSeed % 360}`,
    );
  });
});

it("uses the shared resolver and rejects cross-origin presence avatar metadata", async () => {
  const avatar = document.createElement("openclaw-viewer-avatar") as ViewerAvatarElement;
  avatar.user = {
    id: "profile-mallory",
    name: "Mallory",
    avatarUrl: "https://evil.example/avatar.png",
    watchedSessions: [],
  };
  document.body.append(avatar);

  await vi.waitFor(async () => {
    await avatar.updateComplete;
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent?.trim()).toBe("M");
  });
});

it("renders trusted presence avatar routes directly", async () => {
  const avatar = document.createElement("openclaw-viewer-avatar") as ViewerAvatarElement;
  avatar.user = {
    id: "profile-ada",
    name: "Ada Lovelace",
    avatarUrl: "/api/users/profile-ada/avatar",
    watchedSessions: [],
  };
  document.body.append(avatar);

  await vi.waitFor(async () => {
    await avatar.updateComplete;
    expect(avatar.querySelector("img")?.getAttribute("src")).toBe("/api/users/profile-ada/avatar");
  });
});

it("derives a missing presence avatar from the durable profile id, not the email", async () => {
  const profileId = "c3e32452-0467-47e5-aafa-233cd5dae29f";
  const avatar = document.createElement("openclaw-viewer-avatar") as ViewerAvatarElement;
  avatar.user = {
    id: profileId,
    email: "ada@example.test",
    name: "Ada Lovelace",
    watchedSessions: [],
  };
  document.body.append(avatar);

  await vi.waitFor(async () => {
    await avatar.updateComplete;
    expect(avatar.querySelector("img")?.getAttribute("src")).toBe(`/api/users/${profileId}/avatar`);
  });
});

it("shares an authenticated avatar blob between the same user in the roster and profile", async () => {
  setAvatarGatewayOrigin("https://gateway.example.test", "Bearer viewer-token");
  const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    }),
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-viewer-avatar");
  const user: PresenceViewer = {
    id: "profile-ada",
    email: "ada@example.test",
    name: "Ada Lovelace",
    avatarUrl: "/api/users/profile-ada/avatar?v=7",
    watchedSessions: [],
  };
  const avatars = Array.from({ length: 2 }, () => {
    const avatar = document.createElement("openclaw-viewer-avatar") as ViewerAvatarElement;
    avatar.user = user;
    document.body.append(avatar);
    return avatar;
  });

  await vi.waitFor(async () => {
    await Promise.all(avatars.map((avatar) => avatar.updateComplete));
    expect(avatars.map((avatar) => avatar.querySelector("img")?.getAttribute("src"))).toEqual([
      "blob:shared-viewer-avatar",
      "blob:shared-viewer-avatar",
    ]);
  });

  expect(fetchAvatar).toHaveBeenCalledOnce();
  expect(fetchAvatar).toHaveBeenCalledWith(
    "https://gateway.example.test/api/users/profile-ada/avatar?v=7",
    expect.objectContaining({ headers: { Authorization: "Bearer viewer-token" } }),
  );
  for (const avatar of avatars) {
    avatar.querySelector("img")?.dispatchEvent(new Event("load"));
    expect(avatar.querySelector(".viewer-avatar")?.classList.contains("is-fallback")).toBe(false);
  }
});

type ViewerFacepileElement = HTMLElement & {
  presencePayload: unknown;
  selfUserId?: string;
  selfInstanceId?: string;
  sessionKey?: string;
  excludeUserId?: string;
  staticUsers?: readonly PresenceViewer[];
  staticTooltips?: readonly string[];
  maxVisible: number;
  updateComplete: Promise<boolean>;
};

it("keeps session facepiles as plain non-interactive avatar clusters", async () => {
  const facepile = document.createElement("openclaw-viewer-facepile") as ViewerFacepileElement;
  facepile.presencePayload = {
    presence: [
      {
        instanceId: "alice-1",
        user: { id: "alice", name: "Alice" },
        watchedSessions: [],
      },
    ],
  };
  document.body.append(facepile);

  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(facepile.querySelector(".viewer-facepile")).not.toBeNull();
  });
  expect(facepile.querySelector("button")).toBeNull();
  expect(facepile.querySelectorAll("openclaw-tooltip")).toHaveLength(1);
});

it("renders ordered static participant actors without presence filtering", async () => {
  // SAFETY: the registered custom element exposes the tested reactive properties.
  const facepile = document.createElement("openclaw-viewer-facepile") as ViewerFacepileElement;
  facepile.maxVisible = 2;
  facepile.staticTooltips = ["Ada · Member", "Research · Agent", "Bob · Member"];
  facepile.staticUsers = [
    { id: "profile-ada", name: "Ada", watchedSessions: [] },
    { id: "research", name: "Research", watchedSessions: [] },
    { id: "profile-bob", name: "Bob", watchedSessions: [] },
  ];
  document.body.append(facepile);

  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(
      [...facepile.querySelectorAll("[data-viewer-id]")].map((node) =>
        node.getAttribute("data-viewer-id"),
      ),
    ).toEqual(["profile-ada", "research"]);
  });
  expect(facepile.querySelector(".viewer-avatar--overflow")?.textContent?.trim()).toBe("+1");
  const tooltips = [...facepile.querySelectorAll("openclaw-tooltip")];
  expect(
    tooltips.slice(0, 2).map((tooltip) => (tooltip as HTMLElement & { content?: string }).content),
  ).toEqual(["Ada · Member", "Research · Agent"]);
  const overflowContent = tooltips[2]?.querySelector('[slot="content"]');
  expect(
    [...(overflowContent?.querySelectorAll(".viewer-facepile__overflow-tooltip-row") ?? [])].map(
      (row) => row.querySelector(".viewer-facepile__overflow-tooltip-label")?.textContent?.trim(),
    ),
  ).toEqual(["Bob · Member"]);
  expect(overflowContent?.querySelectorAll("openclaw-viewer-avatar")).toHaveLength(1);
  expect(overflowContent?.querySelector("[data-viewer-id]")).toBeNull();
});

it("excludes the session owner before choosing visible avatars and overflow", async () => {
  const facepile = document.createElement("openclaw-viewer-facepile") as ViewerFacepileElement;
  facepile.sessionKey = "agent:main:active";
  facepile.excludeUserId = "owner";
  facepile.maxVisible = 2;
  facepile.presencePayload = {
    presence: ["owner", "alice", "bob", "carol"].map((id) => ({
      instanceId: `${id}-instance`,
      user: { id, name: id },
      watchedSessions: ["agent:main:active"],
    })),
  };
  document.body.append(facepile);

  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(
      [...facepile.querySelectorAll("[data-viewer-id]")].map((avatar) =>
        avatar.getAttribute("data-viewer-id"),
      ),
    ).toEqual(["alice", "bob"]);
  });
  expect(facepile.querySelector(".viewer-facepile")?.getAttribute("data-viewer-count")).toBe("3");
  expect(facepile.querySelector(".viewer-avatar--overflow")?.textContent?.trim()).toBe("+1");
  expect(facepile.querySelector('[data-viewer-id="owner"]')).toBeNull();
  expect(facepile.querySelector(".viewer-avatar--overflow")?.getAttribute("aria-label")).toBe(
    "carol",
  );
});

it("detects only other viewers watching the requested session", () => {
  const payload = {
    presence: [
      {
        instanceId: "self-instance",
        user: { id: "self", name: "Self" },
        watchedSessions: ["agent:main:active"],
      },
      {
        instanceId: "alice-instance",
        user: { id: "alice", name: "Alice" },
        watchedSessions: ["agent:main:other"],
      },
    ],
  };
  expect(hasSessionPresenceViewers(payload, "self", "self-instance", "agent:main:active")).toBe(
    false,
  );
  expect(hasSessionPresenceViewers(payload, "self", "self-instance", "agent:main:other")).toBe(
    true,
  );
  expect(
    hasSessionPresenceViewers(payload, "self", "self-instance", "agent:main:other", "alice"),
  ).toBe(false);
});

it.each([
  {
    name: "the browser instance id is not populated yet",
    selfInstanceId: undefined,
    presence: [
      {
        user: { id: "self", name: "Self" },
        watchedSessions: ["agent:main:active"],
      },
      {
        user: { id: "alice", name: "Alice" },
        watchedSessions: ["agent:main:active"],
      },
    ],
  },
  {
    name: "the browser's own presence row lacks a user id",
    selfInstanceId: "self-instance",
    presence: [
      { instanceId: "self-instance", watchedSessions: ["agent:main:active"] },
      {
        instanceId: "self-second-tab",
        user: { id: "self", name: "Self" },
        watchedSessions: ["agent:main:active"],
      },
      {
        user: { id: "alice", name: "Alice" },
        watchedSessions: ["agent:main:active"],
      },
    ],
  },
])("excludes authenticated self from session facepiles when $name", async (fixture) => {
  const facepile = document.createElement("openclaw-viewer-facepile") as ViewerFacepileElement;
  facepile.selfUserId = "self";
  facepile.selfInstanceId = fixture.selfInstanceId;
  facepile.sessionKey = "agent:main:active";
  facepile.presencePayload = { presence: fixture.presence };
  document.body.append(facepile);

  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(facepile.querySelector('[data-viewer-id="self"]')).toBeNull();
    expect(facepile.querySelector('[data-viewer-id="alice"]')).not.toBeNull();
  });
});

it("keeps collaboration UI dormant for a solo identity", () => {
  const solo = {
    presence: [
      {
        instanceId: "self-instance",
        user: { id: "self", name: "Self" },
        watchedSessions: ["agent:main:active"],
      },
      {
        instanceId: "second-tab",
        user: { id: "self", name: "Self" },
        watchedSessions: ["agent:main:active"],
      },
    ],
  };
  expect(hasMultiplePresenceIdentities(solo)).toBe(false);
  expect(
    hasMultiplePresenceIdentities({
      presence: [...solo.presence, { user: { id: "alice" }, watchedSessions: [] }],
    }),
  ).toBe(true);
});
