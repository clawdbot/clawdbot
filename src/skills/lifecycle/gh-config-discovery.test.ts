import { describe, expect, it } from "vitest";
import {
  detectGhConfigDirMismatch,
  formatGhConfigDirMismatchHint,
  type GhConfigDirMismatch,
  type GhConfigDiscoveryInput,
} from "./gh-config-discovery.js";

function makeInput(overrides: Partial<GhConfigDiscoveryInput>): GhConfigDiscoveryInput {
  return {
    platform: "linux",
    env: {},
    fileExists: () => false,
    ...overrides,
  };
}

function fileSet(...paths: readonly string[]): (absolutePath: string) => boolean {
  const set = new Set(paths);
  return (absolutePath) => set.has(absolutePath);
}

describe("detectGhConfigDirMismatch", () => {
  it("returns 'explicit-gh-config-dir-set' when GH_CONFIG_DIR is already set", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/agent/home", GH_CONFIG_DIR: "/etc/openclaw/gh" },
      }),
    );
    expect(result).toEqual({ kind: "explicit-gh-config-dir-set", ghConfigDir: "/etc/openclaw/gh" });
  });

  it("returns 'no-process-home' when HOME and XDG and APPDATA are missing", () => {
    const result = detectGhConfigDirMismatch(makeInput({ env: {} }));
    expect(result).toEqual({ kind: "no-process-home" });
  });

  it("returns 'auth-discoverable' when the effective config dir already has hosts.yml", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/agent/home" },
        fileExists: fileSet("/agent/home/.config/gh/hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "auth-discoverable",
      effectiveConfigDir: "/agent/home/.config/gh",
    });
  });

  it("flags a mismatch when /root/.config/gh has hosts.yml but the agent HOME does not", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/root/.openclaw/agents/main/agent/codex-home/home" },
        fileExists: fileSet("/root/.config/gh/hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "mismatch",
      effectiveConfigDir: "/root/.openclaw/agents/main/agent/codex-home/home/.config/gh",
      alternateConfigDir: "/root/.config/gh",
      alternateHostsFile: "/root/.config/gh/hosts.yml",
      alternateHomeHint: "/root",
      suggestedEnvValue: "/root/.config/gh",
    });
  });

  it("uses SUDO_USER home as a candidate when set", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/var/lib/openclaw/agent", SUDO_USER: "alice" },
        fileExists: fileSet("/home/alice/.config/gh/hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "mismatch",
      effectiveConfigDir: "/var/lib/openclaw/agent/.config/gh",
      alternateConfigDir: "/home/alice/.config/gh",
      alternateHostsFile: "/home/alice/.config/gh/hosts.yml",
      alternateHomeHint: "/home/alice",
      suggestedEnvValue: "/home/alice/.config/gh",
    });
  });

  it("uses USER home as a fallback candidate when SUDO_USER is missing", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/var/lib/openclaw/agent", USER: "ops" },
        fileExists: fileSet("/home/ops/.config/gh/hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "mismatch",
      effectiveConfigDir: "/var/lib/openclaw/agent/.config/gh",
      alternateConfigDir: "/home/ops/.config/gh",
      alternateHostsFile: "/home/ops/.config/gh/hosts.yml",
      alternateHomeHint: "/home/ops",
      suggestedEnvValue: "/home/ops/.config/gh",
    });
  });

  it("ignores USER=root since /root is already part of the default candidate set", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/agent/home", USER: "root" },
        fileExists: fileSet("/root/.config/gh/hosts.yml"),
      }),
    );
    expect(result.kind).toBe("mismatch");
  });

  it("returns 'no-known-auth' when no candidate has hosts.yml", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/agent/home" },
        fileExists: () => false,
      }),
    );
    expect(result).toEqual({
      kind: "no-known-auth",
      effectiveConfigDir: "/agent/home/.config/gh",
    });
  });

  it("does not flag a mismatch when the agent HOME equals the operator HOME", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/root" },
        fileExists: fileSet("/root/.config/gh/hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "auth-discoverable",
      effectiveConfigDir: "/root/.config/gh",
    });
  });

  it("respects XDG_CONFIG_HOME for the effective config dir on Linux", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/agent/home", XDG_CONFIG_HOME: "/agent/xdg" },
        fileExists: fileSet("/agent/xdg/gh/hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "auth-discoverable",
      effectiveConfigDir: "/agent/xdg/gh",
    });
  });

  it("respects XDG_CONFIG_HOME before HOME on darwin", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        platform: "darwin",
        env: { HOME: "/Users/agent", XDG_CONFIG_HOME: "/Users/agent/Library/XDG" },
        fileExists: fileSet("/Users/agent/Library/XDG/gh/hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "auth-discoverable",
      effectiveConfigDir: "/Users/agent/Library/XDG/gh",
    });
  });

  it("uses HOME/.config/gh on darwin (matches gh's documented macOS lookup)", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        platform: "darwin",
        env: { HOME: "/Users/agent" },
        fileExists: fileSet("/Users/operator/.config/gh/hosts.yml"),
        candidateOperatorHomes: ["/Users/operator"],
      }),
    );
    expect(result).toEqual({
      kind: "mismatch",
      effectiveConfigDir: "/Users/agent/.config/gh",
      alternateConfigDir: "/Users/operator/.config/gh",
      alternateHostsFile: "/Users/operator/.config/gh/hosts.yml",
      alternateHomeHint: "/Users/operator",
      suggestedEnvValue: "/Users/operator/.config/gh",
    });
  });

  it("uses APPDATA/GitHub CLI on win32", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\agent\\AppData\\Roaming" },
        fileExists: fileSet("C:\\Users\\agent\\AppData\\Roaming\\GitHub CLI\\hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "auth-discoverable",
      effectiveConfigDir: "C:\\Users\\agent\\AppData\\Roaming\\GitHub CLI",
    });
  });

  it("respects XDG_CONFIG_HOME before APPDATA on win32", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        platform: "win32",
        env: {
          XDG_CONFIG_HOME: "C:\\Users\\agent\\XDG",
          APPDATA: "C:\\Users\\agent\\AppData\\Roaming",
        },
        fileExists: fileSet("C:\\Users\\agent\\XDG\\gh\\hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "auth-discoverable",
      effectiveConfigDir: "C:\\Users\\agent\\XDG\\gh",
    });
  });

  it("falls back to HOME/.config/gh on win32 when APPDATA and USERPROFILE are missing", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        platform: "win32",
        env: { HOME: "C:\\Users\\agent" },
        fileExists: fileSet("C:\\Users\\agent\\.config\\gh\\hosts.yml"),
      }),
    );
    expect(result).toEqual({
      kind: "auth-discoverable",
      effectiveConfigDir: "C:\\Users\\agent\\.config\\gh",
    });
  });

  it("respects an explicit candidateOperatorHomes list", () => {
    const result = detectGhConfigDirMismatch(
      makeInput({
        env: { HOME: "/agent/home" },
        fileExists: fileSet("/srv/automation/.config/gh/hosts.yml"),
        candidateOperatorHomes: ["/srv/automation"],
      }),
    );
    expect(result).toEqual({
      kind: "mismatch",
      effectiveConfigDir: "/agent/home/.config/gh",
      alternateConfigDir: "/srv/automation/.config/gh",
      alternateHostsFile: "/srv/automation/.config/gh/hosts.yml",
      alternateHomeHint: "/srv/automation",
      suggestedEnvValue: "/srv/automation/.config/gh",
    });
  });
});

describe("formatGhConfigDirMismatchHint", () => {
  it("formats the mismatch into operator-actionable lines", () => {
    const mismatch: GhConfigDirMismatch = {
      effectiveConfigDir: "/agent/home/.config/gh",
      alternateConfigDir: "/root/.config/gh",
      alternateHostsFile: "/root/.config/gh/hosts.yml",
      alternateHomeHint: "/root",
      suggestedEnvValue: "/root/.config/gh",
    };
    expect(formatGhConfigDirMismatchHint(mismatch)).toEqual([
      "GitHub CLI auth was found at a different HOME than the one this OpenClaw process uses.",
      "  Process gh config dir: /agent/home/.config/gh",
      "  Authenticated config:  /root/.config/gh (contains hosts.yml)",
      "  Authenticated HOME:    /root",
      "  Fix: set GH_CONFIG_DIR=/root/.config/gh on the OpenClaw service environment, then restart the gateway.",
    ]);
  });

  it("omits the home hint line when the alternate has no associated HOME", () => {
    const mismatch: GhConfigDirMismatch = {
      effectiveConfigDir: "/agent/home/.config/gh",
      alternateConfigDir: "/srv/automation/.config/gh",
      alternateHostsFile: "/srv/automation/.config/gh/hosts.yml",
      suggestedEnvValue: "/srv/automation/.config/gh",
    };
    const lines = formatGhConfigDirMismatchHint(mismatch);
    expect(lines.join("\n")).not.toContain("Authenticated HOME");
    expect(lines).toContain(
      "  Fix: set GH_CONFIG_DIR=/srv/automation/.config/gh on the OpenClaw service environment, then restart the gateway.",
    );
  });
});
