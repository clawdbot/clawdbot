// Tests for the Codex `agents/openai.yaml` sidecar reader.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readCodexImplicitInvocationDisabled } from "./codex-invocation-policy.js";

describe("readCodexImplicitInvocationDisabled", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;

  beforeEach(() => {
    root = tempDirs.make("codex-sidecar-");
  });

  function writeSidecar(skillName: string, content: string | null) {
    const skillDir = join(root, skillName);
    mkdirSync(join(skillDir, "agents"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: ${skillName}\n---\n`,
    );
    if (content !== null) {
      writeFileSync(join(skillDir, "agents", "openai.yaml"), content);
    }
    return skillDir;
  }

  it("returns false when no sidecar is present", () => {
    const dir = writeSidecar("no-sidecar", null);
    expect(readCodexImplicitInvocationDisabled(dir)).toBe(false);
  });

  it("returns true when policy.allow_implicit_invocation is false", () => {
    const dir = writeSidecar("explicit-only", "policy:\n  allow_implicit_invocation: false\n");
    expect(readCodexImplicitInvocationDisabled(dir)).toBe(true);
  });

  it("returns false when policy.allow_implicit_invocation is true", () => {
    const dir = writeSidecar("implicit-ok", "policy:\n  allow_implicit_invocation: true\n");
    expect(readCodexImplicitInvocationDisabled(dir)).toBe(false);
  });

  it("returns false when the sidecar omits the policy key", () => {
    const dir = writeSidecar("no-policy", "interface:\n  display_name: No Policy\n");
    expect(readCodexImplicitInvocationDisabled(dir)).toBe(false);
  });

  it("honors the policy alongside an interface block (real-world shape)", () => {
    const dir = writeSidecar(
      "full-sidecar",
      "interface:\n  display_name: Full\npolicy:\n  allow_implicit_invocation: false\n",
    );
    expect(readCodexImplicitInvocationDisabled(dir)).toBe(true);
  });

  it("returns false on unparseable YAML (never restricts on malformed input)", () => {
    const dir = writeSidecar(
      "malformed",
      "policy: [unclosed\n  allow_implicit_invocation: false\n",
    );
    expect(readCodexImplicitInvocationDisabled(dir)).toBe(false);
  });

  it("returns false when allow_implicit_invocation is a non-boolean value", () => {
    const dir = writeSidecar("string-val", 'policy:\n  allow_implicit_invocation: "false"\n');
    expect(readCodexImplicitInvocationDisabled(dir)).toBe(false);
  });
});
