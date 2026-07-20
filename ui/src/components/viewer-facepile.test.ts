/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar.ts";
import type { PresenceViewer } from "./viewer-facepile.ts";
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
    expect(avatar.textContent?.trim()).toBe("MA");
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

type ViewerFacepileElement = HTMLElement & {
  presencePayload: unknown;
  selfInstanceId?: string;
  variant: "session" | "footer";
  updateComplete: Promise<boolean>;
};

function mountFooterFacepile() {
  const facepile = document.createElement("openclaw-viewer-facepile") as ViewerFacepileElement;
  facepile.variant = "footer";
  facepile.selfInstanceId = "self-instance";
  facepile.presencePayload = {
    presence: [
      {
        instanceId: "self-instance",
        user: { id: "00-self", name: "Self User", email: "self@example.test" },
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

it("opens a who's-online roster from the footer facepile", async () => {
  const facepile = mountFooterFacepile();

  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(facepile.querySelector("button.viewer-facepile-trigger")).not.toBeNull();
  });

  facepile.querySelector<HTMLButtonElement>("button.viewer-facepile-trigger")?.click();

  await vi.waitFor(async () => {
    await facepile.updateComplete;
    const items = [...document.querySelectorAll(".presence-roster-menu__item")];
    // Everyone online is listed — including self, sorted first and marked.
    expect(items.map((item) => item.getAttribute("data-viewer-id"))).toEqual([
      "00-self",
      "alice",
      "bob",
    ]);
  });

  const menu = document.querySelector(".presence-roster-menu");
  expect(menu?.querySelector(".presence-roster-menu__title")?.textContent).toContain("3");
  const rows = [...(menu?.querySelectorAll(".presence-roster-menu__item") ?? [])];
  expect(rows[0]?.querySelector(".presence-roster-menu__you")?.textContent).toContain("you");
  // Named users show the email as a subtitle; email-only users don't repeat it.
  expect(rows[1]?.querySelector(".presence-roster-menu__email")?.textContent).toBe(
    "alice@example.test",
  );
  expect(rows[2]?.querySelector(".presence-roster-menu__name")?.textContent?.trim()).toBe(
    "bob@example.test",
  );
  expect(rows[2]?.querySelector(".presence-roster-menu__email")).toBeNull();
  // Each row carries the shared avatar element.
  expect(rows[1]?.querySelector("openclaw-viewer-avatar")).not.toBeNull();
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
});

it("closes the roster when a row is selected", async () => {
  const facepile = mountFooterFacepile();
  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(facepile.querySelector("button.viewer-facepile-trigger")).not.toBeNull();
  });
  facepile.querySelector<HTMLButtonElement>("button.viewer-facepile-trigger")?.click();
  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(document.querySelector(".presence-roster-menu")).not.toBeNull();
  });

  document
    .querySelector(".presence-roster-menu")
    ?.dispatchEvent(new CustomEvent("wa-select", { bubbles: true, cancelable: true }));

  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(document.querySelector(".presence-roster-menu")).toBeNull();
  });
});

it("drops a stale open roster when presence empties and does not reopen on return", async () => {
  const facepile = mountFooterFacepile();
  const fullPresence = facepile.presencePayload;
  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(facepile.querySelector("button.viewer-facepile-trigger")).not.toBeNull();
  });
  facepile.querySelector<HTMLButtonElement>("button.viewer-facepile-trigger")?.click();
  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(document.querySelector(".presence-roster-menu")).not.toBeNull();
  });

  // Everyone else disconnects: the facepile (and menu) unmount without a
  // wa-after-hide, so the open state must clear instead of going stale.
  facepile.presencePayload = {
    presence: [
      {
        instanceId: "self-instance",
        user: { id: "00-self", name: "Self User", email: "self@example.test" },
        watchedSessions: [],
      },
    ],
  };
  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(document.querySelector(".presence-roster-menu")).toBeNull();
  });

  facepile.presencePayload = fullPresence;
  await vi.waitFor(async () => {
    await facepile.updateComplete;
    expect(facepile.querySelector("button.viewer-facepile-trigger")).not.toBeNull();
  });
  // Presence returning must not resurrect the previously open menu.
  expect(document.querySelector(".presence-roster-menu")).toBeNull();
});
