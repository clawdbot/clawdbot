import { describe, expect, it } from "vitest";
import type { ResolvedQmdConfig } from "./backend-config.js";
import { deriveQmdScopeChannel, deriveQmdScopeChatType, isQmdScopeAllowed } from "./qmd-scope.js";

describe("qmd scope", () => {
  const allowDirect: ResolvedQmdConfig["scope"] = {
    default: "deny",
    rules: [{ action: "allow", match: { chatType: "direct" } }],
  };

  it("derives channel and chat type from canonical keys once", () => {
    expect(deriveQmdScopeChannel("Workspace:group:123")).toBe("workspace");
    expect(deriveQmdScopeChatType("Workspace:group:123")).toBe("group");
  });

  it("derives channel and chat type from stored key suffixes", () => {
    expect(deriveQmdScopeChannel("agent:agent-1:workspace:channel:chan-123")).toBe("workspace");
    expect(deriveQmdScopeChatType("agent:agent-1:workspace:channel:chan-123")).toBe("channel");
  });

  it("treats parsed keys with no chat prefix as direct", () => {
    expect(deriveQmdScopeChannel("agent:agent-1:peer-direct")).toBeUndefined();
    expect(deriveQmdScopeChatType("agent:agent-1:peer-direct")).toBe("direct");
    expect(isQmdScopeAllowed(allowDirect, "agent:agent-1:peer-direct")).toBe(true);
    expect(isQmdScopeAllowed(allowDirect, "agent:agent-1:peer:group:abc")).toBe(false);
  });

  it("applies scoped key-prefix checks against normalized key", () => {
    const scope: ResolvedQmdConfig["scope"] = {
      default: "deny",
      rules: [{ action: "allow", match: { keyPrefix: "workspace:" } }],
    };
    expect(isQmdScopeAllowed(scope, "agent:agent-1:workspace:group:123")).toBe(true);
    expect(isQmdScopeAllowed(scope, "agent:agent-1:other:group:123")).toBe(false);
  });

  it("supports rawKeyPrefix matches for agent-prefixed keys", () => {
    const scope: ResolvedQmdConfig["scope"] = {
      default: "allow",
      rules: [{ action: "deny", match: { rawKeyPrefix: "agent:main:guildchat:" } }],
    };
    expect(isQmdScopeAllowed(scope, "agent:main:guildchat:channel:c123")).toBe(false);
    expect(isQmdScopeAllowed(scope, "agent:main:workspace:channel:c123")).toBe(true);
  });

  it("keeps legacy agent-prefixed keyPrefix rules working", () => {
    const scope: ResolvedQmdConfig["scope"] = {
      default: "allow",
      rules: [{ action: "deny", match: { keyPrefix: "agent:main:guildchat:" } }],
    };
    expect(isQmdScopeAllowed(scope, "agent:main:guildchat:channel:c123")).toBe(false);
    expect(isQmdScopeAllowed(scope, "agent:main:workspace:channel:c123")).toBe(true);
  });
});
