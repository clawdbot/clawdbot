/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
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

it("shows one footer hover card with every online user and server details", async () => {
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
  expect(card?.querySelector(".sidebar-hover-card__heading")?.textContent).toContain("Online · 3");
  const rows = [...(card?.querySelectorAll(".sidebar-hover-card__person") ?? [])];
  expect(card?.querySelector(".sidebar-hover-card__people")?.getAttribute("tabindex")).toBe("0");
  expect(rows.map((row) => row.getAttribute("data-viewer-id"))).toEqual(["z-self", "alice", "bob"]);
  expect(rows[0]?.querySelector(".sidebar-hover-card__you")?.textContent).toContain("you");
  // Named users show the email as a subtitle; email-only users don't repeat it.
  expect(rows[1]?.querySelector(".sidebar-hover-card__person-email")?.textContent).toBe(
    "alice@example.test",
  );
  expect(rows[2]?.querySelector(".sidebar-hover-card__person-name")?.textContent?.trim()).toBe(
    "bob@example.test",
  );
  expect(rows[2]?.querySelector(".sidebar-hover-card__person-email")).toBeNull();
  expect(rows[1]?.querySelector("openclaw-viewer-avatar")).not.toBeNull();
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
