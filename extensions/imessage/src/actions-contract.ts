export const IMESSAGE_ACTIONS = {
  react: { gate: "reactions" },
  edit: { gate: "edit" },
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

type IMessageActionSpecs = typeof IMESSAGE_ACTIONS;

export const IMESSAGE_ACTION_NAMES = Object.keys(IMESSAGE_ACTIONS) as Array<
  keyof IMessageActionSpecs
>;
