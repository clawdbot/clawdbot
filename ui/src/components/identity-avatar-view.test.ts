/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { resolveAvatarInitials } from "../lib/identity-avatar.ts";
import {
  identityAvatarClass,
  identityAvatarImage,
  renderIdentityAvatarImage,
  resolveIdentityAvatarView,
  type IdentityAvatarView,
} from "./identity-avatar-view.ts";

function renderAvatar(view: IdentityAvatarView, container: HTMLElement) {
  return render(
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
  it.each(["/favicon.svg", "/control/assets/mascot.svg?v=build-1"])(
    "preserves the public image %s through reconnect without authenticated fetching",
    (url) => {
      setAvatarGatewayOrigin(globalThis.location.origin, ["avatar-token"], "/control");
      const fetchAvatar = vi.spyOn(globalThis, "fetch");
      const container = document.createElement("div");
      const part = render(html`<img src=${identityAvatarImage(url)} />`, container);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
      part.setConnected(false);
      part.setConnected(true);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
      expect(fetchAvatar).not.toHaveBeenCalled();
      render(nothing, container);
    },
  );

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

  it("does not restore a retired Gateway's image when its view reconnects", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["old-token"]);
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:old-gateway");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const container = document.createElement("div");
    const part = renderAvatar(
      resolveIdentityAvatarView({
        id: "profile-ada",
        name: "Ada",
        profileAvatarUrl: "/api/users/profile-ada/avatar?v=1",
      }),
      container,
    );
    const source = () => container.querySelector("img")?.getAttribute("src");
    await vi.waitFor(() => expect(source()).toBe("blob:old-gateway"));
    part.setConnected(false);
    setAvatarGatewayOrigin("https://replacement.example.test", ["new-token"]);
    part.setConnected(true);
    expect(source()).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:old-gateway");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    render(nothing, container);
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

  it("retains pending images independently through replacement and reconnect under pressure", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const avatar = createDeferred<Response>();
    const pressure = createDeferred<Response>();
    const response = () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    let avatarRequests = 0;
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/avatar/pending-")) {
        return pressure.promise;
      }
      avatarRequests += 1;
      return avatarRequests === 1 ? avatar.promise : Promise.resolve(response());
    });
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:view-${sequence++}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const identity = {
      id: "profile-ada",
      name: "Ada",
      profileAvatarUrl: "/api/users/profile-ada/avatar?v=1",
    };
    const first = document.body.appendChild(document.createElement("div"));
    const second = document.body.appendChild(document.createElement("div"));
    renderAvatar(resolveIdentityAvatarView(identity), first);
    const part = renderAvatar(resolveIdentityAvatarView(identity), second);
    const pressureLoads = Array.from({ length: 128 }, (_, index) =>
      Promise.resolve(resolveAvatarImageUrl(`/avatar/pending-${index}?v=1`)),
    );
    render(nothing, first);
    avatar.resolve(response());
    const image = () => second.querySelector<HTMLImageElement>("img");
    try {
      await vi.waitFor(() => expect(image()?.getAttribute("src")).toBe("blob:view-0"));
      image()?.dispatchEvent(new Event("load"));
      expect(revoke).not.toHaveBeenCalledWith("blob:view-0");
      part.setConnected(false);
      expect(revoke).toHaveBeenCalledWith("blob:view-0");
      part.setConnected(true);
      await vi.waitFor(() => expect(image()?.getAttribute("src")).toBe("blob:view-1"));
      renderAvatar(resolveIdentityAvatarView(identity), second);
      expect(image()?.getAttribute("src")).toBe("blob:view-1");
      expect(avatarRequests).toBe(2);
      renderAvatar(
        resolveIdentityAvatarView({
          ...identity,
          profileAvatarUrl: "/api/users/profile-ada/avatar?v=2",
        }),
        second,
      );
      await vi.waitFor(() => expect(image()?.getAttribute("src")).toBe("blob:view-2"));
      expect(revoke).toHaveBeenCalledWith("blob:view-1");
      expect(revoke).not.toHaveBeenCalledWith("blob:view-2");
      expect(fetchAvatar).toHaveBeenCalledTimes(131);
    } finally {
      render(nothing, first);
      render(nothing, second);
      pressure.resolve(new Response(null, { status: 404 }));
      await Promise.all(pressureLoads);
    }
  });
});
