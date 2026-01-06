import { describe, expect, it } from "vitest";

import { isSignalGroupAllowed } from "./monitor.js";

describe("signal groupPolicy gating", () => {
  it("allows when policy is open", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "open",
        allowFrom: [],
        sender: "+15550001111",
      }),
    ).toBe(true);
  });

  it("blocks when policy is disabled", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "disabled",
        allowFrom: ["+15550001111"],
        sender: "+15550001111",
      }),
    ).toBe(false);
  });

  it("blocks allowlist when empty", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: [],
        sender: "+15550001111",
      }),
    ).toBe(false);
  });

  it("allows allowlist when sender matches", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: ["+15550001111"],
        sender: "+15550001111",
      }),
    ).toBe(true);
  });

  it("allows allowlist wildcard", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: ["*"],
        sender: "+15550002222",
      }),
    ).toBe(true);
  });
});
