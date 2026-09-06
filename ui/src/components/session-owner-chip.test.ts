/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import "./session-owner-chip.ts";

afterEach(() => {
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

async function waitForChipUpdate(chip: HTMLElementTagNameMap["openclaw-session-owner-chip"]) {
  await chip.updateComplete;
  // The parent's update does not include the nested avatar's render.
  await Promise.all(
    [...chip.querySelectorAll("openclaw-viewer-avatar")].map((avatar) => avatar.updateComplete),
  );
}

async function mount(params: { participants?: SessionParticipant[]; participantCount?: number }) {
  const chip = document.createElement("openclaw-session-owner-chip");
  chip.owner = { type: "human", id: "profile-ada", label: "Ada" };
  chip.attribution = "owned";
  chip.size = "row";
  chip.participants = params.participants ?? [];
  chip.participantCount = params.participantCount ?? chip.participants.length;
  document.body.append(chip);
  await waitForChipUpdate(chip);
  expect(chip.querySelector(".session-owner-chip")).not.toBeNull();
  return chip;
}

it("keeps the single owner chip unchanged without participants", async () => {
  const chip = await mount({});
  expect(chip.querySelector(".session-owner-stack")).toBeNull();
  expect(chip.querySelectorAll(".session-owner-chip")).toHaveLength(1);
  expect(chip.querySelector(".session-owner-chip")?.getAttribute("aria-label")).toBe(
    "Owned by Ada",
  );
});

it("renders one participant behind the owner with combined accessibility", async () => {
  const chip = await mount({
    participants: [
      {
        identity: { type: "agent", id: "research" },
        label: "Research",
        avatarUrl: "/avatar/research",
      },
    ],
    participantCount: 1,
  });
  expect(chip.querySelector(".session-owner-stack__back .viewer-avatar")).not.toBeNull();
  expect(chip.querySelector(".session-owner-stack__front")).not.toBeNull();
  expect(chip.querySelector(".session-owner-stack")?.getAttribute("aria-label")).toBe(
    "Owned by Ada · with Research",
  );
  expect(chip.querySelector(".session-owner-stack__back img")?.getAttribute("src")).toBe(
    "/avatar/research",
  );
});

it.each(["row", "header"] as const)(
  "renders the configured agent picture in a %s owner chip",
  async (size) => {
    const chip = await mount({});
    chip.owner = {
      type: "agent",
      id: "research",
      identity: { type: "agent", id: "research" },
      label: "Research",
      avatarUrl: "/avatar/research",
    };
    chip.size = size;
    await waitForChipUpdate(chip);
    expect(chip.querySelector(".session-owner-chip img")?.getAttribute("src")).toBe(
      "/avatar/research",
    );
  },
);

it("renders the total participant count in the back slot for three identities", async () => {
  const chip = await mount({
    participants: [
      { identity: { type: "profile", id: "profile-bob" }, label: "Bob" },
      { identity: { type: "agent", id: "research" }, label: "Research" },
    ],
    participantCount: 2,
  });
  expect(chip.querySelector(".session-owner-stack__overflow")?.textContent).toBe("+2");
  expect(chip.querySelector(".session-owner-stack")?.getAttribute("aria-label")).toBe(
    "Owned by Ada · +2 more",
  );
});
