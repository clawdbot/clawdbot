import type { ChannelMessageActionName } from "./types.public.js";

export type BlueBubblesActionSpec = {
  gate: string;
  groupOnly?: boolean;
  unsupportedOnMacOS26?: boolean;
};

export const BLUEBUBBLES_ACTIONS = {
  react: { gate: "reactions" },
  edit: { gate: "edit", unsupportedOnMacOS26: true },
  unsend: { gate: "unsend" },
  reply: { gate: "reply" },
  sendWithEffect: { gate: "sendWithEffect" },
  renameGroup: { gate: "renameGroup", groupOnly: true },
  setGroupIcon: { gate: "setGroupIcon", groupOnly: true },
  addParticipant: { gate: "addParticipant", groupOnly: true },
  removeParticipant: { gate: "removeParticipant", groupOnly: true },
  leaveGroup: { gate: "leaveGroup", groupOnly: true },
  sendAttachment: { gate: "sendAttachment" },
} as const satisfies Partial<Record<ChannelMessageActionName, BlueBubblesActionSpec>>;

const BLUEBUBBLES_ACTION_SPECS = BLUEBUBBLES_ACTIONS as Record<
  keyof typeof BLUEBUBBLES_ACTIONS,
  BlueBubblesActionSpec
>;

export const BLUEBUBBLES_ACTION_NAMES = Object.keys(
  BLUEBUBBLES_ACTIONS,
) as (keyof typeof BLUEBUBBLES_ACTIONS)[];

export const BLUEBUBBLES_GROUP_ACTIONS = new Set<ChannelMessageActionName>(
  BLUEBUBBLES_ACTION_NAMES.filter((action) => BLUEBUBBLES_ACTION_SPECS[action]?.groupOnly),
);
