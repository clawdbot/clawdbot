// Openshell tests cover deterministic sandbox naming.
import { describe, expect, it } from "vitest";
import { buildOpenShellSandboxName } from "./backend.js";

const DNS_1123_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

describe("OpenShell sandbox names", () => {
  const scopeKeys = [
    "agent:main",
    "agent:an-agent-with-a-long-scope-key-that-needs-compaction",
    "session:primary",
    "shared:team:engineering",
    "agent:hello__world..!",
    "agent:\u{1F99E}:\u00DCnicode",
    "",
  ];

  it.each(scopeKeys)("keeps %j within the OpenShell DNS label limit", (scopeKey) => {
    const name = buildOpenShellSandboxName(scopeKey);

    expect(name.length).toBeLessThanOrEqual(19);
    expect(name).toMatch(DNS_1123_LABEL_RE);
    expect(name).not.toContain("--");
  });

  it("is deterministic across repeated calls", () => {
    const scopeKey = "agent:main:thread:123";

    expect(buildOpenShellSandboxName(scopeKey)).toBe(buildOpenShellSandboxName(scopeKey));
  });

  it("keeps representative session, agent, and shared keys distinct", () => {
    const names = new Set(
      ["session:primary", "agent:main", "shared:team"].map(buildOpenShellSandboxName),
    );

    expect(names.size).toBe(3);
  });

  it("uses the hash suffix to distinguish values with the same slug", () => {
    const first = buildOpenShellSandboxName("agent:foo_bar");
    const second = buildOpenShellSandboxName("agent:foo.bar");

    expect(first.slice(0, 7)).toBe(second.slice(0, 7));
    expect(first).not.toBe(second);
  });

  it("uses the session fallback for empty input", () => {
    expect(buildOpenShellSandboxName("   ")).toBe(buildOpenShellSandboxName("session"));
  });
});
