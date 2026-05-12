import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  isSafeBinUsage,
  matchAllowlist,
  normalizeExecApprovals,
  normalizeSafeBins,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
  type ExecApprovalsAgent,
  type ExecAllowlistEntry,
  type ExecApprovalsFile,
} from "./exec-approvals.js";

describe("exec approvals wildcard agent", () => {
  it("merges wildcard allowlist entries with agent entries", () => {
    const dir = makeTempDir();
    const prevOpenClawHome = process.env.OPENCLAW_HOME;

    try {
      process.env.OPENCLAW_HOME = dir;
      const approvalsPath = path.join(dir, ".openclaw", "exec-approvals.json");
      fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
      fs.writeFileSync(
        approvalsPath,
        JSON.stringify(
          {
            version: 1,
            agents: {
              "*": { allowlist: [{ pattern: "/bin/hostname" }] },
              main: { allowlist: [{ pattern: "/usr/bin/uname" }] },
            },
          },
          null,
          2,
        ),
      );

      const resolved = resolveExecApprovals("main");
      expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual([
        "/bin/hostname",
        "/usr/bin/uname",
      ]);
    } finally {
      if (prevOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = prevOpenClawHome;
      }
    }
  });
});

describe("exec approvals node host allowlist check", () => {
  // These tests verify the allowlist satisfaction logic used by the node host path
  // The node host checks: matchAllowlist() || isSafeBinUsage() for each command segment
  // Using hardcoded resolution objects for cross-platform compatibility

  it.each([
    {
      resolution: {
        rawExecutable: "python3",
        resolvedPath: "/usr/bin/python3",
        executableName: "python3",
      },
      entries: [{ pattern: "/usr/bin/python3" }],
      expectedPattern: "/usr/bin/python3",
    },
    {
      // Simulates symlink resolution:
      // /opt/homebrew/bin/python3 -> /opt/homebrew/opt/python@3.14/bin/python3.14
      resolution: {
        rawExecutable: "python3",
        resolvedPath: "/opt/homebrew/opt/python@3.14/bin/python3.14",
        executableName: "python3.14",
      },
      entries: [{ pattern: "/opt/**/python*" }],
      expectedPattern: "/opt/**/python*",
    },
    {
      resolution: {
        rawExecutable: "unknown-tool",
        resolvedPath: "/usr/local/bin/unknown-tool",
        executableName: "unknown-tool",
      },
      entries: [{ pattern: "/usr/bin/python3" }, { pattern: "/opt/**/node" }],
      expectedPattern: null,
    },
  ])(
    "matches exact and wildcard allowlist patterns for %j",
    ({ resolution, entries, expectedPattern }) => {
      const match = matchAllowlist(entries, resolution);
      expect(match?.pattern ?? null).toBe(expectedPattern);
    },
  );

  it("does not treat unknown tools as safe bins", () => {
    const resolution = {
      rawExecutable: "unknown-tool",
      resolvedPath: "/usr/local/bin/unknown-tool",
      executableName: "unknown-tool",
    };
    const safe = isSafeBinUsage({
      argv: ["unknown-tool", "--help"],
      resolution,
      safeBins: normalizeSafeBins(["jq", "curl"]),
    });
    expect(safe).toBe(false);
  });

  it("satisfies via safeBins even when not in allowlist", () => {
    const resolution = {
      rawExecutable: "jq",
      resolvedPath: "/usr/bin/jq",
      executableName: "jq",
    };
    // Not in allowlist
    const entries: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/python3" }];
    const match = matchAllowlist(entries, resolution);
    expect(match).toBeNull();

    // But is a safe bin with non-file args
    const safe = isSafeBinUsage({
      argv: ["jq", ".foo"],
      resolution,
      safeBins: normalizeSafeBins(["jq"]),
    });
    // Safe bins are disabled on Windows (PowerShell parsing/expansion differences).
    if (process.platform === "win32") {
      expect(safe).toBe(false);
      return;
    }
    expect(safe).toBe(true);
  });
});

describe("exec approvals default agent migration", () => {
  it("migrates legacy default agent entries to main", () => {
    const file: ExecApprovalsFile = {
      version: 1,
      agents: {
        default: { allowlist: [{ pattern: "/bin/legacy" }] },
      },
    };
    const resolved = resolveExecApprovalsFromFile({ file });
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual(["/bin/legacy"]);
    expect(resolved.file.agents?.default).toBeUndefined();
    expect(resolved.file.agents?.main?.allowlist?.[0]?.pattern).toBe("/bin/legacy");
  });

  it("prefers main agent settings when both main and default exist", () => {
    const file: ExecApprovalsFile = {
      version: 1,
      agents: {
        main: { ask: "always", allowlist: [{ pattern: "/bin/main" }] },
        default: { ask: "off", allowlist: [{ pattern: "/bin/legacy" }] },
      },
    };
    const resolved = resolveExecApprovalsFromFile({ file });
    expect(resolved.agent.ask).toBe("always");
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual(["/bin/main", "/bin/legacy"]);
    expect(resolved.file.agents?.default).toBeUndefined();
  });
});

describe("exec approvals invalid explicit policy fallback", () => {
  it("treats invalid explicit agent fields as masked and falls back to defaults instead of wildcard", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: {
        version: 1,
        defaults: {
          security: "deny",
          ask: "on-miss",
          askFallback: "deny",
        },
        agents: {
          "*": {
            security: "full",
            ask: "always",
            askFallback: "full",
          },
          runner: {
            security: "foo" as unknown as ExecApprovalsAgent["security"],
            ask: "Always" as unknown as ExecApprovalsAgent["ask"],
            askFallback: "bar" as unknown as ExecApprovalsAgent["askFallback"],
          },
        },
      },
      agentId: "runner",
      overrides: {
        security: "full",
        ask: "off",
        askFallback: "full",
      },
    });

    expect(resolved.agent.security).toBe("deny");
    expect(resolved.agent.ask).toBe("on-miss");
    expect(resolved.agent.askFallback).toBe("deny");
    expect(resolved.agentSources).toEqual({
      security: "defaults.security",
      ask: "defaults.ask",
      askFallback: "defaults.askFallback",
    });
  });

  it("treats null explicit agent fields as unset and still considers wildcard", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: {
        version: 1,
        defaults: {
          security: "full",
          ask: "off",
          askFallback: "full",
        },
        agents: {
          "*": {
            security: "deny",
            ask: "always",
            askFallback: "deny",
          },
          runner: {
            security: null as unknown as ExecApprovalsAgent["security"],
            ask: null as unknown as ExecApprovalsAgent["ask"],
            askFallback: null as unknown as ExecApprovalsAgent["askFallback"],
          },
        },
      },
      agentId: "runner",
      overrides: {
        security: "full",
        ask: "off",
        askFallback: "full",
      },
    });

    expect(resolved.agent.security).toBe("deny");
    expect(resolved.agent.ask).toBe("always");
    expect(resolved.agent.askFallback).toBe("deny");
    expect(resolved.agentSources).toEqual({
      security: "agents.*.security",
      ask: "agents.*.ask",
      askFallback: "agents.*.askFallback",
    });
  });
});

describe("normalizeExecApprovals handles string allowlist entries (#9790)", () => {
  function normalizeMainAllowlist(file: ExecApprovalsFile): ExecAllowlistEntry[] | undefined {
    const normalized = normalizeExecApprovals(file);
    return normalized.agents?.main?.allowlist;
  }

  function expectNoSpreadStringArtifacts(entries: ExecAllowlistEntry[]) {
    for (const entry of entries) {
      expect(entry).toHaveProperty("pattern");
      expect(typeof entry.pattern).toBe("string");
      expect(entry.pattern.length).toBeGreaterThan(0);
      expect(entry).not.toHaveProperty("0");
    }
  }

  it("converts bare string entries to proper ExecAllowlistEntry objects", () => {
    // Simulates a corrupted or legacy config where allowlist contains plain
    // strings (e.g. ["ls", "cat"]) instead of { pattern: "..." } objects.
    const file = {
      version: 1,
      agents: {
        main: {
          mode: "allowlist",
          allowlist: ["things", "remindctl", "memo", "which", "ls", "cat", "echo"],
        },
      },
    } as unknown as ExecApprovalsFile;

    const normalized = normalizeExecApprovals(file);
    const entries = normalized.agents?.main?.allowlist ?? [];

    // Spread-string corruption would create numeric keys — ensure none exist.
    expectNoSpreadStringArtifacts(entries);

    expect(entries.map((e) => e.pattern)).toEqual([
      "things",
      "remindctl",
      "memo",
      "which",
      "ls",
      "cat",
      "echo",
    ]);
  });

  it("preserves proper ExecAllowlistEntry objects unchanged", () => {
    const file: ExecApprovalsFile = {
      version: 1,
      agents: {
        main: {
          allowlist: [{ pattern: "/usr/bin/ls" }, { pattern: "/usr/bin/cat", id: "existing-id" }],
        },
      },
    };

    const normalized = normalizeExecApprovals(file);
    const entries = normalized.agents?.main?.allowlist ?? [];

    expect(entries).toHaveLength(2);
    expect(entries[0]?.pattern).toBe("/usr/bin/ls");
    expect(entries[1]?.pattern).toBe("/usr/bin/cat");
    expect(entries[1]?.id).toBe("existing-id");
  });

  it.each([
    {
      name: "mixed entries",
      allowlist: ["ls", { pattern: "/usr/bin/cat" }, "echo"],
      expectedPatterns: ["ls", "/usr/bin/cat", "echo"],
    },
    {
      name: "empty strings dropped",
      allowlist: ["", "  ", "ls"],
      expectedPatterns: ["ls"],
    },
    {
      name: "malformed objects dropped",
      allowlist: [{ pattern: "/usr/bin/ls" }, {}, { pattern: 123 }, { pattern: "   " }, "echo"],
      expectedPatterns: ["/usr/bin/ls", "echo"],
    },
    {
      name: "non-array dropped",
      allowlist: "ls",
      expectedPatterns: undefined,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    allowlist: unknown;
    expectedPatterns: string[] | undefined;
  }>)("$name", ({ allowlist, expectedPatterns }) => {
    const file = {
      version: 1,
      agents: {
        main: { allowlist } as ExecApprovalsAgent,
      },
    } satisfies ExecApprovalsFile;
    const entries = normalizeMainAllowlist(file);
    expect(entries?.map((entry) => entry.pattern)).toEqual(expectedPatterns);
    if (entries) {
      expectNoSpreadStringArtifacts(entries);
    }
  });
});

describe("normalizeExecApprovals strips invalid security/ask enum values (#59006)", () => {
  it("drops invalid defaults.security values like 'none'", () => {
    const file = {
      version: 1,
      defaults: { security: "none" },
      agents: {},
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.security).toBeUndefined();
  });

  it("drops invalid defaults.ask values like 'never'", () => {
    const file = {
      version: 1,
      defaults: { ask: "never" },
      agents: {},
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.ask).toBeUndefined();
  });

  it("drops invalid defaults.askFallback values", () => {
    const file = {
      version: 1,
      defaults: { askFallback: "none" },
      agents: {},
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.askFallback).toBeUndefined();
  });

  it("preserves valid defaults.security and defaults.ask values", () => {
    const file: ExecApprovalsFile = {
      version: 1,
      defaults: { security: "full", ask: "off", askFallback: "deny" },
      agents: {},
    };
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.security).toBe("full");
    expect(normalized.defaults?.ask).toBe("off");
    expect(normalized.defaults?.askFallback).toBe("deny");
  });

  it("drops invalid agent-level security/ask values", () => {
    const file = {
      version: 1,
      agents: {
        main: { security: "none", ask: "never", askFallback: "open" },
      },
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.agents?.main?.security).toBeUndefined();
    expect(normalized.agents?.main?.ask).toBeUndefined();
    expect(normalized.agents?.main?.askFallback).toBeUndefined();
  });

  it("drops invalid wildcard agent security/ask values", () => {
    const file = {
      version: 1,
      agents: {
        "*": { security: "none", ask: "off" },
      },
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.agents?.["*"]?.security).toBeUndefined();
    expect(normalized.agents?.["*"]?.ask).toBe("off");
  });

  it("resolves to built-in defaults when invalid values are stripped", () => {
    const file = {
      version: 1,
      defaults: { security: "none", ask: "never" },
      agents: {
        "*": { security: "none", ask: "off" },
      },
    } as unknown as ExecApprovalsFile;
    const resolved = resolveExecApprovalsFromFile({ file });
    // Invalid "none" in defaults is stripped, so fallback to DEFAULT_SECURITY ("full")
    expect(resolved.defaults.security).toBe("full");
    // Invalid "never" in defaults is stripped, so fallback to DEFAULT_ASK ("off")
    expect(resolved.defaults.ask).toBe("off");
    // Wildcard agent "none" is stripped, so agent inherits resolved defaults
    expect(resolved.agent.security).toBe("full");
    // Wildcard agent ask="off" is valid and preserved
    expect(resolved.agent.ask).toBe("off");
  });

  it("strips non-string policy values (e.g. numbers, booleans) without throwing", () => {
    const file = {
      version: 1,
      defaults: { security: 1, ask: true, askFallback: ["deny"] },
      agents: {
        main: { security: 42, ask: false },
      },
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.security).toBeUndefined();
    expect(normalized.defaults?.ask).toBeUndefined();
    expect(normalized.defaults?.askFallback).toBeUndefined();
    expect(normalized.agents?.main?.security).toBeUndefined();
    expect(normalized.agents?.main?.ask).toBeUndefined();
  });
});
