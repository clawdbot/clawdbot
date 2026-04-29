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
      expect.stringContaining("No command owner is configured."),
      "Command owner",
    );
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("human operator account");
    expect(message).toContain("DM pairing only lets someone talk to the bot");
    expect(message).toContain("commands.ownerAllowFrom");
  });

  it("does not warn when command owners are configured", () => {
    noteCommandOwnerHealth({ commands: { ownerAllowFrom: ["telegram:123"] } });

    expect(note).not.toHaveBeenCalled();
  });
});
