/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderIdentitySection } from "./identity-section.ts";

type IdentitySectionProps = Parameters<typeof renderIdentitySection>[0];

function createProps(overrides: Partial<IdentitySectionProps> = {}): IdentitySectionProps {
  return {
    userAvatar: null,
    onUserAvatarChange: vi.fn(),
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAvatarUrl: null,
    assistantAvatarSource: null,
    assistantAvatarStatus: null,
    assistantAvatarReason: null,
    basePath: "",
    ...overrides,
  };
}

function expectAssistantAvatarSource(container: Element): { label: string; source: string } {
  const source = container.querySelector(".config-identity--assistant .config-identity__source");
  return {
    label: source?.querySelector("span")?.textContent?.trim() ?? "",
    source: source?.querySelector("code")?.textContent?.trim() ?? "",
  };
}

describe("renderIdentitySection", () => {
  it("keeps the local user name fixed and shows the assistant identity", () => {
    const container = document.createElement("div");

    render(
      renderIdentitySection(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "assets/avatars/nova-portrait.png",
          assistantAvatarUrl: "blob:nova",
        }),
      ),
      container,
    );

    const titles = Array.from(container.querySelectorAll(".config-identity__title")).map((node) =>
      node.textContent?.trim(),
    );
    expect(titles).toEqual(["You", "Nova"]);
    expect(container.querySelector('input[placeholder="You"]')).toBeNull();
    expect(
      container
        .querySelector(".config-identity--assistant .config-identity__avatar")
        ?.getAttribute("src"),
    ).toBe("blob:nova");
  });

  it("anchors the section on the stable settings-search target id", () => {
    const container = document.createElement("div");

    render(renderIdentitySection(createProps()), container);

    expect(container.querySelector("#settings-profile-identity")).not.toBeNull();
  });

  it("falls back to the built-in logo when the assistant avatar request fails", () => {
    const container = document.createElement("div");

    render(
      renderIdentitySection(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "assets/avatars/nova-portrait.png",
          assistantAvatarUrl: "/openclaw/avatar/main",
          assistantAvatarStatus: "local",
          basePath: "/openclaw",
        }),
      ),
      container,
    );

    const avatar = container.querySelector<HTMLImageElement>(
      ".config-identity--assistant .config-identity__avatar",
    );
    expect(avatar?.getAttribute("src")).toBe("/openclaw/avatar/main");

    avatar?.dispatchEvent(new Event("error"));

    expect(avatar?.getAttribute("src")).toBe("/openclaw/apple-touch-icon.png");
    expect(avatar?.classList.contains("config-identity__avatar--fallback")).toBe(true);

    avatar?.dispatchEvent(new Event("error"));
    expect(avatar?.getAttribute("src")).toBe("/openclaw/apple-touch-icon.png");
  });

  it("clears the fallback class after a rerendered assistant avatar loads", () => {
    const container = document.createElement("div");

    render(
      renderIdentitySection(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "/avatar/main",
          assistantAvatarUrl: "/avatar/main",
          assistantAvatarStatus: "local",
        }),
      ),
      container,
    );

    const avatar = container.querySelector<HTMLImageElement>(
      ".config-identity--assistant .config-identity__avatar",
    );
    avatar?.dispatchEvent(new Event("error"));
    expect(avatar?.classList.contains("config-identity__avatar--fallback")).toBe(true);

    render(
      renderIdentitySection(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "/avatar/recovered",
          assistantAvatarUrl: "/avatar/recovered",
          assistantAvatarStatus: "local",
        }),
      ),
      container,
    );

    const recoveredAvatar = container.querySelector<HTMLImageElement>(
      ".config-identity--assistant .config-identity__avatar",
    );
    expect(recoveredAvatar).toBe(avatar);
    expect(recoveredAvatar?.getAttribute("src")).toBe("/avatar/recovered");

    recoveredAvatar?.dispatchEvent(new Event("load"));

    expect(recoveredAvatar?.classList.contains("config-identity__avatar--fallback")).toBe(false);
  });

  it("shows the configured avatar source when the assistant falls back to the logo", () => {
    const container = document.createElement("div");

    render(
      renderIdentitySection(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "/avatar/main",
          assistantAvatarUrl: null,
          assistantAvatarSource: "assets/avatars/nova-portrait.png",
          assistantAvatarStatus: "none",
          assistantAvatarReason: "missing",
        }),
      ),
      container,
    );

    expect(
      container
        .querySelector(".config-identity--assistant .config-identity__avatar")
        ?.getAttribute("src"),
    ).toBe("/apple-touch-icon.png");
    expect(expectAssistantAvatarSource(container)).toEqual({
      label: "Configured avatar",
      source: "assets/avatars/nova-portrait.png",
    });
    expect(container.querySelector(".config-identity__issue")?.textContent?.trim()).toBe(
      "File not found",
    );
  });

  it("keeps a bounded avatar source free of lone surrogates", () => {
    const container = document.createElement("div");
    const source = `${"a".repeat(33)}😀${"m".repeat(20)}😀${"b".repeat(23)}`;

    render(
      renderIdentitySection(
        createProps({
          assistantAvatar: "/avatar/main",
          assistantAvatarUrl: null,
          assistantAvatarSource: source,
          assistantAvatarStatus: "none",
        }),
      ),
      container,
    );

    expect(expectAssistantAvatarSource(container).source).toBe(
      `${"a".repeat(33)}...${"b".repeat(23)}`,
    );
  });

  it("keeps a malformed data-image header free of lone surrogates", () => {
    const container = document.createElement("div");
    const source = `data:image/${"a".repeat(20)}😀tail`;

    render(
      renderIdentitySection(
        createProps({
          assistantAvatar: "/avatar/main",
          assistantAvatarUrl: null,
          assistantAvatarSource: source,
          assistantAvatarStatus: "none",
        }),
      ),
      container,
    );

    expect(expectAssistantAvatarSource(container).source).toBe(`data:image/${"a".repeat(20)},...`);
  });

  it("rejects oversized avatar uploads before reading them", () => {
    const onUserAvatarChange = vi.fn();
    const fileReader = vi.fn();
    vi.stubGlobal("FileReader", fileReader);

    try {
      const container = document.createElement("div");
      render(renderIdentitySection(createProps({ onUserAvatarChange })), container);

      const input = Array.from(container.querySelectorAll('input[type="file"]')).find(
        (node) => !node.closest(".config-identity--assistant"),
      );
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Expected user avatar file input");
      }

      const file = new File([new Uint8Array(1_500_001)], "avatar.png", { type: "image/png" });
      Object.defineProperty(input, "files", { configurable: true, value: [file] });

      input.dispatchEvent(new Event("change"));

      expect(fileReader).not.toHaveBeenCalled();
      expect(onUserAvatarChange).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
