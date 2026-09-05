/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { renderProfileHero } from "./profile-hero.ts";
import { createConnectedContext } from "./profile-page.test-support.ts";
import { ProfilePage } from "./profile-page.ts";

const PROFILE_HERO_TEST_TAG = "test-profile-hero-page";
if (!customElements.get(PROFILE_HERO_TEST_TAG)) {
  customElements.define(PROFILE_HERO_TEST_TAG, class extends ProfilePage {});
}

const container = document.createElement("div");
afterEach(() => {
  render(null, container);
  document.body.replaceChildren();
});

it("keeps the connected person's hero independent of the default agent and live name updates", () => {
  const props = {
    row: { id: "clipper", name: "Clipper" },
    identity: null,
    user: { id: "person-1", name: "Ada", email: "ada@example.test" },
    resolveImageUrl: vi.fn(() => null),
    failedAvatarUrl: null,
    onAvatarError: vi.fn(),
  };
  render(renderProfileHero(props), container);
  expect(container.querySelector(".profile-hero__name")?.textContent).toBe("Ada");
  expect(container.querySelector(".profile-hero__handle")?.textContent).toContain(
    "ada@example.test",
  );
  expect(container.textContent).not.toContain("Clipper");

  render(renderProfileHero({ ...props, user: { ...props.user, name: "Ada Lovelace" } }), container);
  expect(container.querySelector(".profile-hero__name")?.textContent).toBe("Ada Lovelace");
  expect(props.resolveImageUrl).not.toHaveBeenCalled();

  render(renderProfileHero({ ...props, user: null }), container);
  expect(container.querySelector(".profile-hero__name")?.textContent).toBe("Clipper");
  expect(container.querySelector(".profile-hero__handle")?.textContent).toContain("@clipper");
  expect(container.querySelector(".profile-hero__avatar-mascot svg")).not.toBeNull();

  render(renderProfileHero({ ...props, user: { id: "gateway-owner" } }), container);
  expect(container.querySelector(".profile-hero__name")?.textContent).toBe(t("nav.owner"));
});

it("honors a live name clear while the profile editor still holds the fetched name", async () => {
  const profile = {
    id: "person-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: ["ada@example.test"],
    githubIdentity: null,
    hasAvatar: false,
  };
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: profile.id, accounts: [], links: [] };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: "Ada",
    email: "ada@example.test",
  });
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_HERO_TEST_TAG);
  provider.append(page);
  document.body.append(provider);
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe("Ada"),
  );

  harness.context.gateway.updateSelfUser?.({ name: undefined });
  await waitForFast(() =>
    expect(page.querySelector(".profile-hero__name")?.textContent).toBe("ada@example.test"),
  );
});
