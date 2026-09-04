import { afterEach, describe, expect, it } from "vitest";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import "../test-helpers/load-styles.ts";
import type { SessionCreatedActor } from "./session-owner-chip.ts";
import "./session-owner-chip.ts";

type OwnerChipElement = HTMLElement & {
  owner: SessionCreatedActor | null;
  participants: readonly SessionParticipant[];
  participantCount: number;
  size: "row" | "header";
  updateComplete: Promise<boolean>;
};

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
});

async function mountOwnerChip(params: {
  participants?: readonly SessionParticipant[];
  participantCount?: number;
}) {
  // SAFETY: the imported module registers this custom element with these reactive properties.
  const chip = document.createElement("openclaw-session-owner-chip") as OwnerChipElement;
  chip.owner = { type: "human", id: "profile-ada", label: "Ada" };
  chip.size = "row";
  chip.participants = params.participants ?? [];
  chip.participantCount = params.participantCount ?? chip.participants.length;
  document.body.append(chip);
  await chip.updateComplete;
  return chip;
}

describe.skipIf(!hasBrowserLayout)("session owner stack layout", () => {
  it.each([
    {
      backSelector: ".session-owner-stack__back .viewer-avatar",
      name: "one participant avatar",
      participantCount: 1,
      participants: [{ identity: { type: "profile" as const, id: "profile-bob" }, label: "Bob" }],
    },
    {
      backSelector: ".session-owner-stack__overflow",
      name: "participant overflow",
      participantCount: 2,
      participants: [
        { identity: { type: "profile" as const, id: "profile-bob" }, label: "Bob" },
        { identity: { type: "agent" as const, id: "research" }, label: "Research" },
      ],
    },
  ])("keeps $name legible as an equal peer behind the owner", async (fixture) => {
    const chip = await mountOwnerChip(fixture);
    const stack = chip.querySelector<HTMLElement>(".session-owner-stack");
    const back = chip.querySelector<HTMLElement>(fixture.backSelector);
    const front = chip.querySelector<HTMLElement>(".session-owner-stack__front");
    if (!stack || !back || !front) {
      throw new Error("expected complete session owner stack");
    }

    const stackBounds = stack.getBoundingClientRect();
    const backBounds = back.getBoundingClientRect();
    const frontBounds = front.getBoundingClientRect();
    expect({
      backSize: [backBounds.width, backBounds.height],
      frontSize: [frontBounds.width, frontBounds.height],
      stackSize: [stackBounds.width, stackBounds.height],
    }).toEqual({
      backSize: [18, 18],
      frontSize: [18, 18],
      stackSize: [28, 20],
    });
    expect(backBounds.right - frontBounds.left).toBe(8);
    expect(frontBounds.left - backBounds.left).toBe(10);
  });

  it("keeps the single-owner row avatar at its established size", async () => {
    const chip = await mountOwnerChip({});
    const owner = chip.querySelector<HTMLElement>(".session-owner-chip--row");
    if (!owner) {
      throw new Error("expected single owner row avatar");
    }
    const bounds = owner.getBoundingClientRect();
    expect([bounds.width, bounds.height]).toEqual([20, 20]);
    expect(chip.querySelector(".session-owner-stack")).toBeNull();
  });
});
