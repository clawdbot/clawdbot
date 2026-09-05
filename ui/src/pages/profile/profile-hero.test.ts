/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { renderProfileHero } from "./profile-hero.ts";

const container = document.createElement("div");
afterEach(() => render(null, container));

it("keeps the connected person's hero independent of the default agent and live name updates", () => {
  const props = {
    agentId: "clipper",
    row: { id: "clipper", name: "Clipper" },
    identity: null,
    user: { id: "person-1", name: "Ada", email: "ada@example.test" },
    displayName: "Old name",
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
});
