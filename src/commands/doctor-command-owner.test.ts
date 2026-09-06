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
      const hint = formatCommandOwnerHint({ cfg: {}, channel: "matrix", id });
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

  it.each([
    { name: "no owners", owners: [], expected: ["telegram:123"] },
    {
      name: "existing owners and duplicates",
      owners: ["slack:owner", "telegram:123", "slack:owner", "*", "telegram:*"],
      expected: ["slack:owner", "telegram:123"],
    },
    {
      name: "a new owner alongside existing owners",
      owners: ["slack:owner"],
      expected: ["slack:owner", "telegram:123"],
    },
  ])("preserves command owners in the hint with $name", ({ owners, expected }) => {
    expect(
      formatCommandOwnerHint({
        cfg: { commands: { ownerAllowFrom: owners } },
        channel: "telegram",
        id: "123",
      }),
    ).toBe(
      `Ask the operator to run \`openclaw config set commands.ownerAllowFrom '${JSON.stringify(expected)}'\` in a terminal to make this sender a command owner.`,
    );
  });

  it("asks the operator to add the sender when config is unavailable", () => {
    expect(formatCommandOwnerHint({ channel: "telegram", id: "123" })).toBe(
      "Ask the operator to add `telegram:123` to `commands.ownerAllowFrom`.",
    );
  });

  it("keeps internal Gateway ownership guidance", () => {
    expect(formatCommandOwnerHint({ cfg: {}, channel: "webchat", id: "123" })).toBe(
      "Ask the operator to grant this Gateway client operator.admin access.",
    );
  });

  it("does not warn when command owners are configured", () => {
    noteCommandOwnerHealth({ commands: { ownerAllowFrom: ["telegram:123"] } });

    expect(note).not.toHaveBeenCalled();
  });
});
