/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
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
    gitCoauthorEnabled: false,
    busy: null,
    error: null,
    onDisplayNameInput: vi.fn(),
    onSaveDisplayName: vi.fn(),
    onAvatarSelect: vi.fn(),
    onGitCoauthorChange: vi.fn(),
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
    ).toEqual([
      "Avatar",
      "Display name",
      "Linked emails",
      "GitHub account",
      "Git co-author credit",
    ]);
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

    const chooser = container.querySelector<HTMLButtonElement>(".identity-avatar-control .btn");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const clickInput = vi.spyOn(input!, "click");
    chooser?.click();
    expect(chooser?.type).toBe("button");
    expect(clickInput).toHaveBeenCalledOnce();

    const file = new File(["avatar"], "avatar.webp", { type: "image/webp" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(input?.accept).toBe("image/png,image/jpeg,image/webp");
    expect(input?.value).toBe("");
    expect(onAvatarSelect).toHaveBeenCalledWith(file);

    render(renderIdentitySection(createProps({ busy: "display-name" })), container);
    expect(
      container.querySelector<HTMLButtonElement>(".identity-avatar-control .btn")?.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
  });

  it("shows verified GitHub identity and explicit co-author credit", () => {
    const onGitCoauthorChange = vi.fn();
    const container = document.createElement("div");
    render(
      renderIdentitySection(
        createProps({
          gitCoauthorEnabled: true,
          profile: {
            ...PROFILE,
            githubIdentity: {
              login: "octocat",
              profileUrl: "https://github.com/octocat",
              avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
            },
          },
          onGitCoauthorChange,
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
    expect(container.querySelector(".identity-github-form")).toBeNull();
    expect(container.textContent).toContain("Verified from your GitHub-backed sign-in");
    expect(container.textContent).not.toContain("Disconnect");
    expect(container.textContent).toContain("public GitHub noreply address");
    expect(container.textContent).toContain("future commits only");
    const toggle = container.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    expect(toggle?.checked).toBe(true);
    expect(toggle?.hasAttribute("disabled")).toBe(false);
    toggle!.checked = false;
    toggle?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onGitCoauthorChange).toHaveBeenCalledWith(false);
  });

  it("explains unavailable GitHub verification and disables co-author credit", () => {
    const container = document.createElement("div");
    render(renderIdentitySection(createProps()), container);

    expect(container.querySelector(".settings-account")).toBeNull();
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("GitHub-backed sign-in");
    expect(container.textContent).toContain("Refresh to retry");
    expect(container.querySelector(".identity-github-form")).toBeNull();
    const toggle = container.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    expect(toggle?.checked).toBe(false);
    expect(toggle?.hasAttribute("disabled")).toBe(true);
  });

  it("explains personal GitHub sign-in for the shared owner without email or retry rows", () => {
    const container = document.createElement("div");
    render(
      renderIdentitySection(
        createProps({ profile: { ...PROFILE, id: "gateway-owner", emails: [] } }),
      ),
      container,
    );

    const descriptions = [...container.querySelectorAll(".settings-row__desc")].map((node) =>
      node.textContent?.trim(),
    );
    expect(descriptions).toContain(
      "GitHub-backed sign-in through Cloudflare Access or Tailscale Serve provides this identity.",
    );
    expect(descriptions).toContain(
      "Requires GitHub-backed sign-in through Cloudflare Access or Tailscale Serve.",
    );
    expect(container.textContent).not.toContain("Linked emails");
    expect(container.textContent).not.toContain("Refresh to retry");
    const toggle = container.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    expect(toggle?.checked).toBe(false);
    expect(toggle?.hasAttribute("disabled")).toBe(true);
  });

  it("reports mutation errors without inventing another settings surface", () => {
    const container = document.createElement("div");
    render(renderIdentitySection(createProps({ error: "Save failed" })), container);

    expect(container.querySelector('[role="alert"]')?.textContent?.trim()).toBe("Save failed");
    expect(container.querySelectorAll(".settings-group")).toHaveLength(1);
  });
});
