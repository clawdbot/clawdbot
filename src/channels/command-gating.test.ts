import { describe, expect, it } from "vitest";

import {
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
} from "./command-gating.js";

describe("resolveCommandAuthorizedFromAuthorizers", () => {
  it("denies when useAccessGroups is enabled and no authorizer is configured", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: true,
        authorizers: [{ configured: false, allowed: true }],
      }),
    ).toBe(false);
  });

  it("allows when useAccessGroups is enabled and any configured authorizer allows", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: true,
        authorizers: [
          { configured: true, allowed: false },
          { configured: true, allowed: true },
        ],
      }),
    ).toBe(true);
  });

  it("allows when useAccessGroups is disabled (default)", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: true, allowed: false }],
      }),
    ).toBe(true);
  });

  it("honors modeWhenAccessGroupsOff=deny", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: false, allowed: true }],
        modeWhenAccessGroupsOff: "deny",
      }),
    ).toBe(false);
  });

  it("honors modeWhenAccessGroupsOff=configured (allow when none configured)", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: false, allowed: false }],
        modeWhenAccessGroupsOff: "configured",
      }),
    ).toBe(true);
  });

  it("honors modeWhenAccessGroupsOff=configured (enforce when configured)", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: true, allowed: false }],
        modeWhenAccessGroupsOff: "configured",
      }),
    ).toBe(false);
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: true, allowed: true }],
        modeWhenAccessGroupsOff: "configured",
      }),
    ).toBe(true);
  });
});

describe("resolveControlCommandGate", () => {
  it("blocks control commands when unauthorized", () => {
    const result = resolveControlCommandGate({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: false }],
      allowTextCommands: true,
      hasControlCommand: true,
    });
    expect(result.commandAuthorized).toBe(false);
    expect(result.shouldBlock).toBe(true);
  });

  it("does not block when control commands are disabled", () => {
    const result = resolveControlCommandGate({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: false }],
      allowTextCommands: false,
      hasControlCommand: true,
    });
    expect(result.shouldBlock).toBe(false);
  });
});
