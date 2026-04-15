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
} as const;

type BlueBubblesActionSpecs = typeof BLUEBUBBLES_ACTIONS;

export const BLUEBUBBLES_ACTION_NAMES = Object.keys(BLUEBUBBLES_ACTIONS) as Array<
  keyof BlueBubblesActionSpecs
>;
