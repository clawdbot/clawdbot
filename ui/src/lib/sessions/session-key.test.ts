// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  canonicalUiSessionKeyForPersistence,
  isUiSelectedGlobalSessionKey,
  parseSessionKeyParts,
  resolveUiSessionNavigationParentKey,
  uiSessionEventMatches,
} from "./session-key.ts";

describe("parseSessionKeyParts", () => {
  it("preserves opaque channel account tails", () => {
    expect(parseSessionKeyParts("agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN")).toEqual({
      agentId: "data-expert",
      channel: "dingtalk",
      accountId: "cidzg6sF43NZMy52Rnk8EN",
    });
    expect(parseSessionKeyParts("agent:main:telegram:user:12345:extra")).toEqual({
      agentId: "main",
      channel: "telegram",
      accountId: "user:12345:extra",
    });
  });

  it.each([
    "global:default",
    "direct:some-key",
    "",
    "agent:",
    "agent:main",
    "agent:main:",
    "agent:main:telegram",
    "Agent:main:telegram:user",
  ])("rejects malformed key %j", (key) => {
    expect(parseSessionKeyParts(key)).toBeNull();
  });
});

describe("UI session identity", () => {
  it.each([
    {
      name: "Matrix room IDs",
      selectedKey: "agent:ops:matrix:channel:!Room:Example.Org",
      structuralAlias: "Agent:Ops:Matrix:Channel:!Room:Example.Org",
      distinctKey: "agent:ops:matrix:channel:!room:example.org",
    },
    {
      name: "Matrix room and thread IDs",
      selectedKey: "agent:ops:matrix:channel:!Room:Example.Org:thread:$Event",
      structuralAlias: "Agent:Ops:Matrix:Channel:!Room:Example.Org:Thread:$Event",
      distinctKey: "agent:ops:matrix:channel:!Room:Example.Org:thread:$event",
    },
    {
      name: "Signal group IDs",
      selectedKey: "agent:ops:signal:group:AbC123=",
      structuralAlias: "Agent:Ops:Signal:Group:AbC123=",
      distinctKey: "agent:ops:signal:group:abc123=",
    },
    {
      name: "Signal group IDs with normalized thread suffixes",
      selectedKey: "agent:ops:signal:group:AbC123=:thread:xyz",
      structuralAlias: "Agent:Ops:Signal:Group:AbC123=:Thread:XyZ",
      distinctKey: "agent:ops:signal:group:abc123=:thread:xyz",
    },
  ])(
    "preserves $name in live events and persisted session identity",
    ({ selectedKey, structuralAlias, distinctKey }) => {
      const host = {
        agentsList: { defaultId: "ops", mainKey: "home" },
        sessionKey: selectedKey,
      };

      expect(uiSessionEventMatches(host, structuralAlias)).toBe(true);
      expect(uiSessionEventMatches(host, distinctKey)).toBe(false);
      expect(canonicalUiSessionKeyForPersistence(host, structuralAlias)).toBe(selectedKey);
      expect(canonicalUiSessionKeyForPersistence(host, distinctKey)).toBe(distinctKey);
    },
  );

  it("retains configured main-session aliases for events and persisted identity", () => {
    const host = {
      agentsList: { defaultId: "ops", mainKey: "home" },
      sessionKey: "agent:ops:home",
    };

    expect(uiSessionEventMatches(host, "main")).toBe(true);
    expect(uiSessionEventMatches(host, "agent:ops:main")).toBe(true);
    expect(canonicalUiSessionKeyForPersistence(host, "main")).toBe("agent:ops:home");
    expect(canonicalUiSessionKeyForPersistence(host, "agent:ops:main")).toBe("agent:ops:home");
    expect(isUiSelectedGlobalSessionKey(host, "agent:ops:home")).toBe(true);
    expect(isUiSelectedGlobalSessionKey(host, "agent:ops:main")).toBe(true);
    expect(isUiSelectedGlobalSessionKey(host, "agent:ops:other")).toBe(false);
  });

  it.each([
    {
      parentSessionKey: "  agent:main:dashboard:navigation-parent  ",
      spawnedBy: "agent:main:controller",
      expected: "agent:main:dashboard:navigation-parent",
    },
    {
      parentSessionKey: "",
      spawnedBy: "  agent:main:controller  ",
      expected: "agent:main:controller",
    },
    {
      parentSessionKey: "  \t  ",
      spawnedBy: "agent:main:controller",
      expected: "agent:main:controller",
    },
    { parentSessionKey: null, spawnedBy: "  ", expected: undefined },
  ])("resolves the first non-empty navigation parent", ({ expected, ...row }) => {
    expect(resolveUiSessionNavigationParentKey(row)).toBe(expected);
  });
});
