import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CommandEntrySchema } from "./commands.js";

const commandEntry = {
  name: "pair",
  textAliases: ["/pair"],
  description: "Pair a device.",
  source: "plugin" as const,
  scope: "both" as const,
  acceptsArgs: true,
};

describe("command client presentation schema", () => {
  it("keeps metadata optional for older gateways and unrelated commands", () => {
    expect(Value.Check(CommandEntrySchema, commandEntry)).toBe(true);
  });

  it("accepts the known closed action", () => {
    expect(
      Value.Check(CommandEntrySchema, {
        ...commandEntry,
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "device-pairing" },
        },
      }),
    ).toBe(true);
  });

  it.each([
    { when: "always", action: { kind: "device-pairing" } },
    { when: "no-arguments", action: { kind: "open-route" } },
    { when: "no-arguments", action: { kind: "device-pairing", callback: "run" } },
    {
      when: "no-arguments",
      action: { kind: "device-pairing" },
      route: "/settings/devices",
    },
  ])("rejects malformed or expanded metadata %#", (clientPresentation) => {
    expect(Value.Check(CommandEntrySchema, { ...commandEntry, clientPresentation })).toBe(false);
  });
});
