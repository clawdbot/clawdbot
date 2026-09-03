// Doctor command-owner tests cover channel sender formatting and configured owner detection.
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatCommandOwnerFromChannelSender,
  formatCommandOwnerHint,
  hasConfiguredCommandOwners,
  noteCommandOwnerHealth,
} from "./doctor-command-owner.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

describe("command owner health", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    note.mockClear();
  });

  it("detects configured command owners", () => {
    expect(hasConfiguredCommandOwners({})).toBe(false);
    expect(hasConfiguredCommandOwners({ commands: { ownerAllowFrom: [] } })).toBe(false);
    expect(hasConfiguredCommandOwners({ commands: { ownerAllowFrom: ["telegram:123"] } })).toBe(
      true,
    );
    expect(hasConfiguredCommandOwners({ commands: { ownerAllowFrom: ["*"] } })).toBe(false);
    expect(hasConfiguredCommandOwners({ commands: { ownerAllowFrom: ["telegram:*"] } })).toBe(
      false,
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
        "A command owner is the human operator account allowed to run owner-only commands and approve dangerous actions, including /diagnostics, /export-session, /export-trajectory, /config, and exec approvals.",
        "CLI pairing approval records the first command owner. Control UI approval has an owner checkbox; otherwise set commands.ownerAllowFrom.",
        "Fix: set commands.ownerAllowFrom to your channel user id, for example openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'",
        "Restart the gateway after changing this if it is already running.",
      ].join("\n"),
      "Command owner",
    );
  });

  it.skipIf(process.platform === "win32")(
    "quotes a sender id without overriding the selected profile",
    () => {
      vi.stubEnv("OPENCLAW_PROFILE", "owner-proof");
      const id = "@o'brien$(printf injected) --profile decoy:example.org";
      const hint = formatCommandOwnerHint({ channel: "matrix", id });
      const command = hint.slice(hint.indexOf("`") + 1, hint.lastIndexOf("`"));
      const args = execFileSync(
        "/bin/sh",
        ["-c", command.replace(/^openclaw /, "printf '%s\\n' ")],
        {
          encoding: "utf8",
        },
      )
        .trim()
        .split("\n");
      expect(args).toEqual([
        "--profile",
        "owner-proof",
        "config",
        "set",
        "commands.ownerAllowFrom",
        JSON.stringify([`matrix:${id}`]),
      ]);
    },
  );

  it("does not warn when command owners are configured", () => {
    noteCommandOwnerHealth({ commands: { ownerAllowFrom: ["telegram:123"] } });

    expect(note).not.toHaveBeenCalled();
  });
});
