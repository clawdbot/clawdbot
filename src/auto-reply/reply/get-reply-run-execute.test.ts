import { describe, expect, it } from "vitest";
import { shouldAdmitFreshChannelOwnerCronAuthority } from "../../agents/cron-creator-authority-context.js";

const BASE = {
  senderIsOwner: true,
  messageProvider: "telegram",
  senderId: "owner-1",
  isHeartbeat: false,
  isRoomEvent: false,
};

describe("fresh channel owner cron authority admission", () => {
  it.each(["telegram", "discord", "slack", "custom-channel"])(
    "admits an authenticated direct owner turn from %s without channel-specific policy",
    (messageProvider) => {
      expect(shouldAdmitFreshChannelOwnerCronAuthority({ ...BASE, messageProvider })).toBe(true);
    },
  );

  it.each([
    { name: "non-owner", overrides: { senderIsOwner: false } },
    { name: "missing provider", overrides: { messageProvider: undefined } },
    { name: "missing sender", overrides: { senderId: undefined } },
    { name: "heartbeat", overrides: { isHeartbeat: true } },
    { name: "room event", overrides: { isRoomEvent: true } },
    { name: "continuation provenance", overrides: { inputProvenance: { kind: "continuation" } } },
    { name: "spawned session", overrides: { spawnedBy: "agent:parent" } },
    { name: "replayed turn", overrides: { suppressNextUserMessagePersistence: true } },
  ])("rejects $name", ({ overrides }) => {
    expect(shouldAdmitFreshChannelOwnerCronAuthority({ ...BASE, ...overrides })).toBe(false);
  });
});
