/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatarInitials } from "../lib/identity-avatar.ts";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
  resolveIdentityAvatarView,
  type IdentityAvatarView,
} from "./identity-avatar-view.ts";

function renderAvatar(view: IdentityAvatarView, container: HTMLElement): void {
  render(
    html`<span class=${identityAvatarClass("test-avatar", view)}>
      ${renderIdentityAvatarImage({
        view,
        fallbackSelector: ".test-avatar",
        className: "test-avatar__image",
        alt: "Ada Lovelace",
        ariaHidden: true,
      })}
    </span>`,
    container,
  );
}

afterEach(() => {
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

describe("shared identity avatar view", () => {
  it("derives fallback initials and colors from the canonical user identity", () => {
    const identity = {
      id: "profile-riley",
      name: "Riley",
      username: "riley@example.test",
    };

    const view = resolveIdentityAvatarView(identity);

    expect(view.fallback).toEqual(resolveAvatarInitials(identity));
    expect(view.fallback.initials).toBe("R");
    expect(view.imageUrl).toBeNull();
    expect(view.pending).toBe(false);
  });

  it("keeps hostile avatar origins out of the shared authenticated renderer", () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const fetchAvatar = vi.spyOn(globalThis, "fetch");

    const view = resolveIdentityAvatarView({
      id: "profile-mallory",
      name: "Mallory",
      profileAvatarUrl: "https://evil.example/api/users/profile-mallory/avatar",
    });

    expect(view.fallback.initials).toBe("M");
    expect(view.imageUrl).toBeNull();
    expect(view.pending).toBe(false);
    expect(fetchAvatar).not.toHaveBeenCalled();
  });

  it("shares authenticated loading and reconciles image fallback events", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-identity-avatar");

    const view = resolveIdentityAvatarView({
      id: "profile-ada",
      name: "Ada Lovelace",
      profileAvatarUrl: "/api/users/profile-ada/avatar?v=7",
    });
    const container = document.createElement("div");
    document.body.append(container);
    renderAvatar(view, container);

    const wrapper = container.querySelector<HTMLElement>(".test-avatar");
    expect(view.pending).toBe(true);
    expect(wrapper?.classList.contains("is-fallback")).toBe(true);

    const image = await vi.waitFor(() => {
      const element = container.querySelector<HTMLImageElement>(".test-avatar__image");
      expect(element?.getAttribute("src")).toBe("blob:shared-identity-avatar");
      return element!;
    });
    expect(image.getAttribute("alt")).toBe("Ada Lovelace");
    expect(image.getAttribute("aria-hidden")).toBe("true");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(fetchAvatar).toHaveBeenCalledWith(
      "https://gateway.example.test/api/users/profile-ada/avatar?v=7",
      expect.objectContaining({ headers: { Authorization: "Bearer avatar-token" } }),
    );

    image.dispatchEvent(new Event("load"));
    expect(wrapper?.classList.contains("is-fallback")).toBe(false);

    image.dispatchEvent(new Event("error"));
    expect(wrapper?.classList.contains("is-fallback")).toBe(true);

    image.dispatchEvent(new Event("load"));
    expect(wrapper?.classList.contains("is-fallback")).toBe(false);
  });

  it("retains its existing image while a newer avatar revision loads", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:identity-avatar-v1")
      .mockReturnValueOnce("blob:identity-avatar-v2");

    const identity = { id: "profile-ada", name: "Ada Lovelace" };
    const container = document.createElement("div");
    document.body.append(container);
    renderAvatar(
      resolveIdentityAvatarView({
        ...identity,
        profileAvatarUrl: "/api/users/profile-ada/avatar?v=1",
      }),
      container,
    );

    const firstImage = await vi.waitFor(() => {
      const image = container.querySelector<HTMLImageElement>(".test-avatar__image");
      expect(image?.getAttribute("src")).toBe("blob:identity-avatar-v1");
      return image!;
    });
    firstImage.dispatchEvent(new Event("load"));

    renderAvatar(
      resolveIdentityAvatarView({
        ...identity,
        profileAvatarUrl: "/api/users/profile-ada/avatar?v=2",
      }),
      container,
    );
    expect(container.querySelector(".test-avatar")?.classList.contains("is-fallback")).toBe(true);

    const secondImage = await vi.waitFor(() => {
      const image = container.querySelector<HTMLImageElement>(".test-avatar__image");
      expect(image?.getAttribute("src")).toBe("blob:identity-avatar-v2");
      return image!;
    });
    expect(secondImage).toBe(firstImage);

    secondImage.dispatchEvent(new Event("load"));
    expect(container.querySelector(".test-avatar")?.classList.contains("is-fallback")).toBe(false);
  });
});
