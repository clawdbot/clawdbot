import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatCommandOwnerFromChannelSender,
  hasConfiguredCommandOwners,
  noteCommandOwnerHealth,
} from "./doctor-command-owner.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

describe("command owner health", () => {
  beforeEach(() => {
    note.mockClear();
  });

  it("detects configured command owners", () => {
    expect(hasConfiguredCommandOwners({})).toBe(false);
    expect(hasConfiguredCommandOwners({ commands: { ownerAllowFrom: [] } })).toBe(false);
    expect(hasConfiguredCommandOwners({ commands: { ownerAllowFrom: ["telegram:123"] } })).toBe(
      true,
    );
  });

  it("formats pairing senders as channel-scoped command owners", () => {
    expect(formatCommandOwnerFromChannelSender({ channel: "telegram", id: "123" })).toBe(
      "telegram:123",
    );
    expect(formatCommandOwnerFromChannelSender({ channel: "telegram", id: "telegram:123" })).toBe(
      "telegram:123",
    );
  });

  it("explains missing command owners in plain language", () => {
    noteCommandOwnerHealth({});

    expect(note).toHaveBeenCalledWith(
      [
        "No command owner is configured.",
        "A command owner is the human operator account allowed to run owner-only commands and approve dangerous actions, including /diagnostics, /export-trajectory, /config, and exec approvals.",
        "DM pairing only lets someone talk to the bot; it does not make that sender the owner for privileged commands.",
        "Fix: set commands.ownerAllowFrom to your channel user id, for example openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'",
        "Restart the gateway after changing this if it is already running.",
      ].join("\n"),
      "Command owner",
    );
  });

  it("does not warn when command owners are configured", () => {
    noteCommandOwnerHealth({ commands: { ownerAllowFrom: ["telegram:123"] } });

    expect(note).not.toHaveBeenCalled();
  });
});
