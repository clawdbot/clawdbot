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
  githubIdentity: null,
  hasAvatar: true,
};

function createProps(overrides: Partial<IdentitySectionProps> = {}): IdentitySectionProps {
  return {
    profile: PROFILE,
    avatarUrl: "/api/users/profile-1/avatar?v=2",
    displayName: "Ada Lovelace",
    githubUsername: "",
    busy: null,
    error: null,
    onDisplayNameInput: vi.fn(),
    onSaveDisplayName: vi.fn(),
    onAvatarSelect: vi.fn(),
    onGitHubUsernameInput: vi.fn(),
    onSaveGitHubIdentity: vi.fn(),
    onClearGitHubIdentity: vi.fn(),
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
    ).toEqual(["Avatar", "Display name", "Linked emails", "GitHub"]);
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

  it("links, changes, and disconnects the public GitHub identity", () => {
    const onGitHubUsernameInput = vi.fn();
    const onSaveGitHubIdentity = vi.fn();
    const onClearGitHubIdentity = vi.fn();
    const container = document.createElement("div");
    render(
      renderIdentitySection(
        createProps({
          githubUsername: "octocat",
          profile: {
            ...PROFILE,
            githubIdentity: {
              login: "octocat",
              profileUrl: "https://github.com/octocat",
              avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
            },
          },
          onGitHubUsernameInput,
          onSaveGitHubIdentity,
          onClearGitHubIdentity,
        }),
      ),
      container,
    );

    const account = container.querySelector<HTMLAnchorElement>(".settings-account");
    expect(account?.href).toBe("https://github.com/octocat");
    expect(account?.target).toBe("_blank");
    expect(account?.rel).toContain("noopener");
    expect(account?.querySelector("img")?.src).toBe(
      "https://avatars.githubusercontent.com/u/583231?v=4",
    );
    const input = container.querySelector<HTMLInputElement>(".identity-github-form input");
    input!.value = "octo-renamed";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".identity-github-form")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Disconnect")
      ?.click();

    expect(onGitHubUsernameInput).toHaveBeenCalledWith("octo-renamed");
    expect(onSaveGitHubIdentity).toHaveBeenCalledOnce();
    expect(onClearGitHubIdentity).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("public GitHub co-author credit");
    expect(container.textContent).toContain("never a private email");
    expect(container.textContent).toContain("account you control");
  });

  it("disables relinking an unchanged canonical GitHub login", () => {
    const container = document.createElement("div");
    render(
      renderIdentitySection(
        createProps({
          githubUsername: " OctoCat ",
          profile: {
            ...PROFILE,
            githubIdentity: {
              login: "octocat",
              profileUrl: "https://github.com/octocat",
              avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
            },
          },
        }),
      ),
      container,
    );

    expect(
      container.querySelector<HTMLButtonElement>('.identity-github-form button[type="submit"]')
        ?.disabled,
    ).toBe(true);
  });

  it("reports mutation errors without inventing another settings surface", () => {
    const container = document.createElement("div");
    render(renderIdentitySection(createProps({ error: "Save failed" })), container);

    expect(container.querySelector('[role="alert"]')?.textContent?.trim()).toBe("Save failed");
    expect(container.querySelectorAll(".settings-group")).toHaveLength(1);
  });
});
