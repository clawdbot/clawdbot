/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar.ts";
import { renderIdentitySection } from "./identity-section.ts";

type IdentitySectionProps = Parameters<typeof renderIdentitySection>[0];

const PROFILE: UserProfile = {
  id: "profile-1",
  displayName: "Ada Lovelace",
  avatarMime: "image/png",
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["ada@example.test", "ada@work.test"],
  hasAvatar: true,
};

function createProps(overrides: Partial<IdentitySectionProps> = {}): IdentitySectionProps {
  return {
    profile: PROFILE,
    avatarUrl: "/api/users/profile-1/avatar?v=2",
    displayName: "Ada Lovelace",
    busy: null,
    error: null,
    onDisplayNameInput: vi.fn(),
    onSaveDisplayName: vi.fn(),
    onAvatarSelect: vi.fn(),
    ...overrides,
  };
}

describe("renderIdentitySection", () => {
  afterEach(() => {
    document.body.replaceChildren();
    setAvatarGatewayOrigin(null);
    vi.restoreAllMocks();
  });

  it("renders the resolved profile through settings rows and the shared avatar", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(renderIdentitySection(createProps()), container);
    const avatar = container.querySelector<HTMLElement>("openclaw-viewer-avatar");
    await vi.waitFor(async () => {
      await (avatar as (HTMLElement & { updateComplete?: Promise<unknown> }) | null)
        ?.updateComplete;
      expect(avatar?.querySelector("img")?.getAttribute("src")).toBe(
        "/api/users/profile-1/avatar?v=2",
      );
    });

    expect(container.querySelector("#settings-profile-identity")).not.toBeNull();
    expect(
      [...container.querySelectorAll(".settings-row__title")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Avatar", "Display name", "Linked emails"]);
    expect(container.textContent).toContain("ada@example.test, ada@work.test");
  });

  it("falls back to initials when no same-origin avatar route is available", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderIdentitySection(
        createProps({
          avatarUrl: null,
          profile: { ...PROFILE, emails: ["profile-preview@example.test"], hasAvatar: false },
        }),
      ),
      container,
    );
    const avatar = container.querySelector<HTMLElement>("openclaw-viewer-avatar") as
      | (HTMLElement & { updateComplete?: Promise<unknown> })
      | null;
    await avatar?.updateComplete;

    // The gateway route (userProfileAvatarUrl) serves the Gravatar fallback
    // server-side and stays same-origin under the Control UI CSP. When no route
    // is available — e.g. a cross-origin gateway returns null — the chip shows
    // deterministic initials rather than a CSP-blocked direct gravatar.com image.
    expect(avatar?.querySelector("img")).toBeNull();
    expect(avatar?.textContent?.trim()).toBe("AL");
  });

  it("edits and saves the display name with the standard input pattern", () => {
    const onDisplayNameInput = vi.fn();
    const onSaveDisplayName = vi.fn();
    const container = document.createElement("div");
    render(
      renderIdentitySection(
        createProps({ displayName: "Ada", onDisplayNameInput, onSaveDisplayName }),
      ),
      container,
    );

    const input = container.querySelector<HTMLInputElement>('.settings-input[type="text"]');
    expect(input?.value).toBe("Ada");
    input!.value = "Augusta Ada";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".identity-name-control")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    expect(onDisplayNameInput).toHaveBeenCalledWith("Augusta Ada");
    expect(onSaveDisplayName).toHaveBeenCalledOnce();
  });

  it("forwards an allowlisted avatar file and resets the picker", () => {
    const onAvatarSelect = vi.fn();
    const container = document.createElement("div");
    render(renderIdentitySection(createProps({ onAvatarSelect })), container);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["avatar"], "avatar.webp", { type: "image/webp" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(input?.accept).toBe("image/png,image/jpeg,image/webp");
    expect(input?.value).toBe("");
    expect(onAvatarSelect).toHaveBeenCalledWith(file);
  });

  it("reports mutation errors without inventing another settings surface", () => {
    const container = document.createElement("div");
    render(renderIdentitySection(createProps({ error: "Save failed" })), container);

    expect(container.querySelector('[role="alert"]')?.textContent?.trim()).toBe("Save failed");
    expect(container.querySelectorAll(".settings-group")).toHaveLength(1);
  });
});
