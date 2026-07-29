/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { resolveAvatarInitials, setAvatarGatewayOrigin } from "../lib/identity-avatar.ts";
import { renderChatAuthorAvatar } from "../pages/chat/components/chat-author-avatar.ts";
import {
  hasMultiplePresenceIdentities,
  hasSessionPresenceViewers,
  type PresenceViewer,
} from "./viewer-facepile.ts";

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
  variant: "session" | "footer";
  buildInfo: ControlUiBuildInfo;
  gatewayVersion: string | null;
  updateComplete: Promise<boolean>;
};

const BUILD_INFO: ControlUiBuildInfo = {
  version: "2026.7.2",
  commit: "1234567890abcdef1234567890abcdef12345678",
  commitAt: null,
  builtAt: "2026-07-20T10:30:00.000Z",
  branch: "main",
  dirty: true,
  buildId: "test",
};

function mountFooterFacepile() {
  const facepile = document.createElement("openclaw-viewer-facepile") as ViewerFacepileElement;
  facepile.variant = "footer";
  facepile.selfUserId = "z-self";
  facepile.selfInstanceId = "self-instance";
  facepile.buildInfo = BUILD_INFO;
  facepile.gatewayVersion = "2026.7.1";
  facepile.presencePayload = {
    presence: [
      {
        instanceId: "self-instance",
        user: { id: "z-self", name: "Self User", email: "self@example.test" },
        watchedSessions: [],
      },
      {
        instanceId: "alice-1",
        user: { id: "alice", name: "Alice", email: "alice@example.test" },
        watchedSessions: [],
      },
      {
        instanceId: "bob-1",
        user: { id: "bob", email: "bob@example.test" },
        watchedSessions: [],
      },
    ],
  };
  document.body.append(facepile);
  return facepile;
}

it("shows one footer hover card with other online users and server details", async () => {
  const facepile = mountFooterFacepile();

  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(facepile.querySelector(".viewer-facepile-trigger")).not.toBeNull();
  });

  const tooltip = facepile.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
    "openclaw-tooltip.sidebar-hover-tooltip",
  );
  await tooltip?.updateComplete;
  const trigger = facepile.querySelector<HTMLElement>(".viewer-facepile-trigger");
  trigger?.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));

  expect(
    tooltip?.shadowRoot?.querySelector<HTMLElement & { open: boolean }>("wa-tooltip")?.open,
  ).toBe(true);
  const card = facepile.querySelector('.sidebar-presence-hover-card[slot="content"]');
  expect(
    [...facepile.querySelectorAll(".viewer-facepile [data-viewer-id]")].map((avatar) =>
      avatar.getAttribute("data-viewer-id"),
    ),
  ).toEqual(["alice", "bob"]);
  expect(card?.querySelector(".sidebar-hover-card__heading")?.textContent).toContain("Online · 2");
  const rows = [...(card?.querySelectorAll(".sidebar-hover-card__person") ?? [])];
  expect(card?.querySelector(".sidebar-hover-card__people")?.getAttribute("tabindex")).toBe("0");
  expect(rows.map((row) => row.getAttribute("data-viewer-id"))).toEqual(["alice", "bob"]);
  expect(card?.querySelector('[data-viewer-id="z-self"]')).toBeNull();
  // Named users show the email as a subtitle; email-only users don't repeat it.
  expect(rows[0]?.querySelector(".sidebar-hover-card__person-email")?.textContent).toBe(
    "alice@example.test",
  );
  expect(rows[1]?.querySelector(".sidebar-hover-card__person-name")?.textContent?.trim()).toBe(
    "bob@example.test",
  );
  expect(rows[1]?.querySelector(".sidebar-hover-card__person-email")).toBeNull();
  expect(rows[0]?.querySelector("openclaw-viewer-avatar")).not.toBeNull();
  expect(card?.textContent).toContain("Server");
  expect(card?.querySelector(".sidebar-hover-card__summary")?.textContent).toContain(
    "v2026.7.2 · main · dirty",
  );
  expect(
    card?.querySelector(".sidebar-hover-card__metadata-value--mono")?.textContent?.trim(),
  ).toBe("1234567890ab");
  expect(card?.textContent).toContain("2026-07-20T10:30:00.000Z");
  expect(card?.textContent).toContain("2026.7.1");
  expect(facepile.querySelector("wa-dropdown")).toBeNull();
  expect(trigger?.hasAttribute("aria-haspopup")).toBe(false);
  expect(trigger?.hasAttribute("aria-expanded")).toBe(false);
});

it("keeps session facepiles as plain non-interactive avatar clusters", async () => {
  const facepile = document.createElement("openclaw-viewer-facepile") as ViewerFacepileElement;
  facepile.variant = "session";
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
  expect(facepile.querySelector("button.viewer-facepile-trigger")).toBeNull();
  expect(facepile.querySelectorAll("openclaw-tooltip")).toHaveLength(1);
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
  facepile.variant = "session";
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
