/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMUNITY_INVITE_KEY,
  readCommunityInviteState,
  type CommunityInviteState,
} from "./community-invite-card.ts";

const COMMUNITY_INVITE_STATE_CHANGED_EVENT = "community-invite-state-changed";

/** The invite link is the product contract this card exists to deliver, so the
 * test states it independently instead of reading back the value under test. */
const COMMUNITY_INVITE_URL = "https://discord.gg/clawd";

// The tag map carries the element type, so no exported class is needed here.
let card: HTMLElementTagNameMap["openclaw-community-invite-card"];
let states: Array<CommunityInviteState | null>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_760_000_000_000);
  localStorage.clear();
  states = [];
  card = document.createElement("openclaw-community-invite-card");
  card.addEventListener(COMMUNITY_INVITE_STATE_CHANGED_EVENT, (event) => {
    states.push((event as CustomEvent<{ state: CommunityInviteState | null }>).detail.state);
  });
  document.body.append(card);
  await card.updateComplete;
});

afterEach(() => {
  card.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it("records the first real mount once", () => {
    expect(JSON.parse(localStorage.getItem(COMMUNITY_INVITE_KEY) ?? "null")).toEqual({
      firstShownAtMs: 1_760_000_000_000,
    });
    expect(states).toEqual([{ firstShownAtMs: 1_760_000_000_000 }]);

    card.remove();
    document.body.append(card);
    expect(JSON.parse(localStorage.getItem(COMMUNITY_INVITE_KEY) ?? "null")).toEqual({
      firstShownAtMs: 1_760_000_000_000,
    });
  });

  it("fails closed when reading browser storage throws", () => {
    vi.spyOn(localStorage, "getItem").mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    expect(readCommunityInviteState()).toBeNull();
  });

  it("resets a future first-shown timestamp as a new cache", () => {
    localStorage.setItem(
      COMMUNITY_INVITE_KEY,
      JSON.stringify({ firstShownAtMs: 1_760_000_000_001 }),
    );
    expect(readCommunityInviteState()).toEqual({});
  });

  it("dismisses only from the close button and persists that decision", () => {
    const close = shadowQuery(".invite__close");
    expect(close.getAttribute("aria-label")).toBe("Dismiss and don't show again");
    vi.setSystemTime(1_760_000_001_000);
    close.click();
    expect(JSON.parse(localStorage.getItem(COMMUNITY_INVITE_KEY) ?? "null")).toEqual({
      firstShownAtMs: 1_760_000_000_000,
      dismissedAtMs: 1_760_000_001_000,
    });
    expect(states.at(-1)).toEqual({
      firstShownAtMs: 1_760_000_000_000,
      dismissedAtMs: 1_760_000_001_000,
    });
  });

  it("keeps the invite active when the Discord link is opened", () => {
    const cta = shadowQuery(".invite__cta");
    expect(cta.getAttribute("href")).toBe(COMMUNITY_INVITE_URL);
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(cta.getAttribute("rel")).toContain("noopener");
    const before = localStorage.getItem(COMMUNITY_INVITE_KEY);
    cta.click();
    expect(localStorage.getItem(COMMUNITY_INVITE_KEY)).toBe(before);
    expect(card.isConnected).toBe(true);
  });
});
