import { describe, expect, it } from "vitest";
import { resolveRequiredNodeCommandAuthority } from "./node-command-policy.js";

const COMMAND = "codex.exec-server.stdio.v1";

describe("resolveRequiredNodeCommandAuthority", () => {
  const cases = [
    {
      name: "invocable when declared, effective, and allowlisted",
      declared: [COMMAND],
      effective: [COMMAND],
      withheld: [],
      allowlist: [COMMAND],
      state: "invocable",
    },
    {
      name: "pending-approval when declared but not yet approved",
      declared: [COMMAND],
      effective: [],
      withheld: [],
      allowlist: [COMMAND],
      state: "pending-approval",
    },
    {
      name: "unauthorized when a hot policy deny withholds a live declaration",
      declared: [COMMAND],
      effective: [],
      withheld: [COMMAND],
      allowlist: [],
      state: "unauthorized",
    },
    {
      name: "unauthorized when the runtime allowlist refuses an effective command",
      declared: [COMMAND],
      effective: [COMMAND],
      withheld: [],
      allowlist: [],
      state: "unauthorized",
    },
    {
      name: "unauthorized when a reconnect withheld the whole declaration",
      declared: [],
      effective: [],
      withheld: [COMMAND],
      allowlist: [],
      state: "unauthorized",
    },
    {
      name: "undeclared when the node never offered the command",
      declared: [],
      effective: [],
      withheld: [],
      allowlist: [COMMAND],
      state: "undeclared",
    },
  ] as const;

  it.each(cases)("$name", ({ declared, effective, withheld, allowlist, state }) => {
    expect(
      resolveRequiredNodeCommandAuthority({
        requiredCommands: [COMMAND],
        declaredCommands: declared,
        effectiveCommands: effective,
        withheldCommands: withheld,
        allowlist: new Set(allowlist),
      }),
    ).toEqual({ command: COMMAND, state });
  });
});
