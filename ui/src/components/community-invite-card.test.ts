/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMUNITY_INVITE_KEY } from "./community-invite-state.ts";
import "./community-invite-card.ts";

const COMMUNITY_INVITE_URL = "https://discord.gg/clawd";

let card: HTMLElementTagNameMap["openclaw-community-invite-card"];

beforeEach(async () => {
  localStorage.clear();
  card = document.createElement("openclaw-community-invite-card");
  document.body.append(card);
  await card.updateComplete;
});

afterEach(() => {
  card.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

function shadowQuery(selector: string): HTMLElement {
  const found = card.shadowRoot?.querySelector(selector);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`missing ${selector}`);
  }
  return found;
}

describe("community invite card", () => {
  it("is a non-modal complementary region, not a dialog", () => {
    const region = shadowQuery("aside.invite");
    expect(region.getAttribute("role")).toBe("complementary");
    // A focus trap or an aria-modal here would make it interrupt the operator.
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(card.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(card.shadowRoot?.querySelector("[autofocus]")).toBeNull();
  });

  it("leaves persistence to the sidebar owner", () => {
    expect(localStorage.getItem(COMMUNITY_INVITE_KEY)).toBeNull();
  });

  it("delegates dismissal from the close button", () => {
    const onDismiss = vi.fn();
    card.onDismiss = onDismiss;
    const close = shadowQuery(".invite__close");
    expect(close.getAttribute("aria-label")).toBe("Dismiss and don't show again");
    close.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(localStorage.getItem(COMMUNITY_INVITE_KEY)).toBeNull();
  });

  it("keeps the invite active when the Discord link is opened", () => {
    const cta = shadowQuery(".invite__cta");
    expect(cta.getAttribute("href")).toBe(COMMUNITY_INVITE_URL);
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(cta.getAttribute("rel")).toContain("noopener");
    cta.click();
    expect(localStorage.getItem(COMMUNITY_INVITE_KEY)).toBeNull();
    expect(card.isConnected).toBe(true);
  });
});
