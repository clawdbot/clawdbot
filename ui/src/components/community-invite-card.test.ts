/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMUNITY_INVITE_KEY,
  dismissCommunityInvite,
  readCommunityInviteState,
} from "./community-invite-state.ts";
import "./community-invite-card.ts";

/** The invite link is the product contract this card exists to deliver, so the
 * test states it independently instead of reading back the value under test. */
const COMMUNITY_INVITE_URL = "https://discord.gg/clawd";

// The tag map carries the element type, so no exported class is needed here.
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

/** Every element the card exposes is an HTMLElement, so one concrete return type
 * covers the button, the anchor and the region without a call-site generic. */
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

  it("fails closed when reading browser storage throws", () => {
    vi.spyOn(localStorage, "getItem").mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    expect(readCommunityInviteState()).toBeNull();
  });

  it("fails closed for stored values that cannot be decoded", () => {
    for (const value of ["", "{", "null", "[]", "{}", '{"dismissedAtMs":"never"}']) {
      localStorage.setItem(COMMUNITY_INVITE_KEY, value);
      expect(readCommunityInviteState()).toBeNull();
    }
  });

  it("reports dismissal failure when the write cannot be read back", () => {
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(dismissCommunityInvite()).toBeNull();
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

  it("persists dismissal through the state owner", () => {
    expect(dismissCommunityInvite(1_760_000_001_000)).toEqual({
      dismissedAtMs: 1_760_000_001_000,
    });
    expect(JSON.parse(localStorage.getItem(COMMUNITY_INVITE_KEY) ?? "null")).toEqual({
      dismissedAtMs: 1_760_000_001_000,
    });
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
