/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresenceViewer } from "./viewer-facepile.ts";
import "./viewer-facepile.ts";

type ViewerAvatarElement = HTMLElement & {
  user: PresenceViewer;
  updateComplete: Promise<boolean>;
};

function viewer(overrides: Partial<PresenceViewer> = {}): PresenceViewer {
  return {
    id: "profile-1",
    name: "Test Person",
    watchedSessions: [],
    ...overrides,
  };
}

async function mountViewer(user: PresenceViewer): Promise<ViewerAvatarElement> {
  const avatar = document.createElement("openclaw-viewer-avatar") as ViewerAvatarElement;
  avatar.user = user;
  document.body.append(avatar);
  await avatar.updateComplete;
  return avatar;
}

async function waitForImage(avatar: ViewerAvatarElement): Promise<HTMLImageElement> {
  await vi.waitFor(() => expect(avatar.querySelector("img")).not.toBeNull());
  return avatar.querySelector<HTMLImageElement>("img")!;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("viewer avatar resolution", () => {
  it("keeps an uploaded avatar ahead of the email fallback", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const avatar = await mountViewer(
      viewer({ email: "test@example.com", avatarUrl: "/api/users/profile-1/avatar?v=2" }),
    );
    const image = await waitForImage(avatar);

    expect(image.getAttribute("src")).toBe("/api/users/profile-1/avatar?v=2");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(digest).not.toHaveBeenCalled();
  });

  it("retries a failed uploaded avatar after the user snapshot updates", async () => {
    const avatarUrl = "/api/users/profile-1/avatar?v=2";
    const avatar = await mountViewer(viewer({ avatarUrl }));
    const failedImage = await waitForImage(avatar);

    failedImage.dispatchEvent(new Event("error"));
    await avatar.updateComplete;
    expect(avatar.querySelector("img")).toBeNull();

    avatar.user = viewer({ avatarUrl });
    await avatar.updateComplete;
    expect(avatar.querySelector("img")?.getAttribute("src")).toBe(avatarUrl);
  });

  it("normalizes and hashes email with SHA-256 for the Gravatar URL", async () => {
    const avatar = await mountViewer(viewer({ email: "  TEST@example.com " }));

    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent?.trim()).toBe("TP");
    const image = await waitForImage(avatar);
    expect(image.getAttribute("src")).toBe(
      "https://gravatar.com/avatar/973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b?d=404&s=128",
    );
  });

  it("falls back to initials when the Gravatar image fails", async () => {
    const avatar = await mountViewer(viewer({ email: "missing-one@example.test" }));
    const image = await waitForImage(avatar);

    image.dispatchEvent(new Event("error"));
    await avatar.updateComplete;

    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent?.trim()).toBe("TP");
  });

  it("does not attribute a stale Gravatar error to the next user", async () => {
    const avatar = await mountViewer(viewer({ email: "first-stale@example.test" }));
    const staleImage = await waitForImage(avatar);

    avatar.user = viewer({ id: "profile-2", email: "second-current@example.test" });
    staleImage.dispatchEvent(new Event("error"));
    await avatar.updateComplete;

    const image = await waitForImage(avatar);
    expect(image.getAttribute("src")).toMatch(
      /^https:\/\/gravatar\.com\/avatar\/[a-f0-9]{64}\?d=404&s=128$/u,
    );
  });

  it("renders initials without attempting a hash when email is absent", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const avatar = await mountViewer(viewer());

    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent?.trim()).toBe("TP");
    expect(digest).not.toHaveBeenCalled();
  });

  it("caches missing Gravatars by normalized email", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const first = await mountViewer(viewer({ email: " Missing-Two@Example.Test " }));
    const image = await waitForImage(first);
    image.dispatchEvent(new Event("error"));
    await first.updateComplete;

    const second = await mountViewer(
      viewer({ id: "profile-2", email: "missing-two@example.test" }),
    );

    expect(second.querySelector("img")).toBeNull();
    expect(digest).toHaveBeenCalledTimes(1);
  });
});
