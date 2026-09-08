/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCommunityInviteCard } from "./community-invite-card.ts";
import { COMMUNITY_INVITE_KEY } from "./community-invite-state.ts";

const COMMUNITY_INVITE_URL = "https://discord.gg/clawd";

const onDismiss = vi.fn<() => void>();
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  onDismiss.mockReset();
  document.body.append(container);
  render(renderCommunityInviteCard(onDismiss), container);
});

afterEach(() => {
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

function cardQuery(selector: string): HTMLElement {
  const found = container.querySelector(selector);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`missing ${selector}`);
  }
  return found;
}

describe("community invite card", () => {
  it("is a non-modal complementary region, not a dialog", () => {
    const region = cardQuery("aside.invite");
    expect(region.getAttribute("role")).toBe("complementary");
    // A focus trap or an aria-modal here would make it interrupt the operator.
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(container.querySelector("[autofocus]")).toBeNull();
  });

  it("leaves persistence to the sidebar owner", () => {
    expect(localStorage.getItem(COMMUNITY_INVITE_KEY)).toBeNull();
  });

  it("delegates dismissal from the close button", () => {
    const close = cardQuery(".invite__close");
    expect(close.getAttribute("aria-label")).toBe("Dismiss and don't show again");
    close.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(localStorage.getItem(COMMUNITY_INVITE_KEY)).toBeNull();
  });

  it("keeps the invite active when the Discord link is opened", () => {
    const cta = cardQuery(".invite__cta");
    expect(cta.getAttribute("href")).toBe(COMMUNITY_INVITE_URL);
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(cta.getAttribute("rel")).toContain("noopener");
    cta.click();
    expect(localStorage.getItem(COMMUNITY_INVITE_KEY)).toBeNull();
    expect(cardQuery(".community-invite-card").isConnected).toBe(true);
  });
});
