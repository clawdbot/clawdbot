// File Transfer tests cover policy plugin behavior.
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the plugin-sdk runtime-config surface so we can drive the policy
// reader from the test without booting a gateway. mutateConfigFile is also
// mocked so literal-grant tests can assert what would have been written
// without touching ~/.openclaw/openclaw.json.
const getRuntimeConfigMock = vi.fn();
const mutateConfigFileMock = vi.fn();

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
}));
vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: (input: unknown) => mutateConfigFileMock(input),
}));

// Imported AFTER vi.mock so the mocked module is what policy.ts binds to.
const { evaluateFilePolicy, persistLiteralGrant } = await import("./policy.js");

beforeEach(() => {
  getRuntimeConfigMock.mockReset();
  mutateConfigFileMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/runtime-config-snapshot");
  vi.doUnmock("openclaw/plugin-sdk/config-mutation");
  vi.resetModules();
});

function withConfig(fileTransfer: Record<string, unknown> | undefined) {
  if (fileTransfer === undefined) {
    getRuntimeConfigMock.mockReturnValue({});
  } else {
    getRuntimeConfigMock.mockReturnValue({
      plugins: {
        entries: {
          "file-transfer": {
            config: { policyVersion: 2, nodes: fileTransfer },
          },
        },
      },
    });
  }
}

function expectResultFields(result: unknown, fields: Record<string, unknown>) {
  if (typeof result !== "object" || result === null) {
    throw new Error("policy result was not an object");
  }
  const record = result as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

describe("evaluateFilePolicy — default deny", () => {
  it("returns NO_POLICY when no plugin config block is present", () => {
    getRuntimeConfigMock.mockReturnValue({});
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: false, code: "NO_POLICY", askable: false });
  });

  it("returns NO_POLICY when plugin policy block is missing", () => {
    getRuntimeConfigMock.mockReturnValue({ plugins: { entries: { "file-transfer": {} } } });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: false, code: "NO_POLICY" });
  });

  it("returns NO_POLICY when no entry exists for the node and no '*' fallback", () => {
    withConfig({ "other-node": { allowReadPaths: ["/tmp/**"] } });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: false, code: "NO_POLICY" });
  });

  it("prefers the current runtime config over a stale passed plugin config", () => {
    getRuntimeConfigMock.mockReturnValue({
      plugins: {
        entries: {
          "file-transfer": {
            config: {
              policyVersion: 2,
              nodes: {
                n1: { allowReadPaths: ["/tmp/**"] },
              },
            },
          },
        },
      },
    });
    const r = evaluateFilePolicy({
      nodeId: "n1",
      kind: "read",
      path: "/tmp/x",
      pluginConfig: {
        nodes: {
          n1: { allowReadPaths: ["/stale/**"] },
        },
      },
    });
    expectResultFields(r, { ok: true, reason: "matched-allow" });
  });

  it("fails closed with the one-command handoff for unreviewed legacy positive policy", () => {
    getRuntimeConfigMock.mockReturnValue({
      plugins: {
        entries: {
          "file-transfer": {
            config: {
              nodes: { Shared: { allowReadPaths: ["/tmp/report-*.txt"] } },
            },
          },
        },
      },
    });

    const result = evaluateFilePolicy({
      nodeId: "node-a",
      nodeDisplayName: "Shared",
      kind: "read",
      command: "file.fetch",
      path: "/tmp/report-secret.txt",
    });

    expectResultFields(result, {
      ok: false,
      code: "POLICY_MIGRATION_REQUIRED",
      askable: false,
    });
    expect(result.ok ? "" : result.reason).toContain("openclaw file-transfer approvals migrate");
  });
});

describe("evaluateFilePolicy — '..' traversal short-circuit", () => {
  it("rejects /allowed/../etc/passwd even when /allowed/** is allowed", () => {
    withConfig({
      n1: { allowReadPaths: ["/allowed/**"] },
    });
    const r = evaluateFilePolicy({
      nodeId: "n1",
      kind: "read",
      path: "/allowed/../etc/passwd",
    });
    expectResultFields(r, { ok: false, code: "POLICY_DENIED", askable: false });
    expect(r.ok ? "" : r.reason).toMatch(/\.\./);
  });

  it("rejects a path that ENDS in /..", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"] },
    });
    const r = evaluateFilePolicy({
      nodeId: "n1",
      kind: "read",
      path: "/tmp/foo/..",
    });
    expectResultFields(r, { ok: false, code: "POLICY_DENIED" });
  });

  it("rejects bare '..'", () => {
    withConfig({
      n1: { allowReadPaths: ["/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: ".." });
    expectResultFields(r, { ok: false, code: "POLICY_DENIED" });
  });
});

describe("evaluateFilePolicy — denyPaths always wins", () => {
  it("denies even when allowReadPaths matches", () => {
    withConfig({
      n1: {
        allowReadPaths: ["/tmp/**"],
        denyPaths: ["**/.ssh/**"],
      },
    });
    const r = evaluateFilePolicy({
      nodeId: "n1",
      kind: "read",
      path: "/tmp/.ssh/id_rsa",
    });
    expectResultFields(r, { ok: false, code: "POLICY_DENIED", askable: false });
    expect(r.ok ? "" : r.reason).toMatch(/deny/);
  });

  it("treats globstar slash as zero or more directories in denyPaths", () => {
    withConfig({
      n1: {
        allowReadPaths: ["~/Downloads/**"],
        denyPaths: ["~/Downloads/**/*.pem"],
      },
    });
    const r = evaluateFilePolicy({
      nodeId: "n1",
      kind: "read",
      path: path.join(os.homedir(), "Downloads", "key.pem"),
    });
    expectResultFields(r, { ok: false, code: "POLICY_DENIED", askable: false });
  });

  it("preserves minimatch brace semantics in denyPaths", () => {
    withConfig({
      n1: {
        allowReadPaths: ["~/Downloads/**"],
        denyPaths: ["~/Downloads/**/*.{pem,key}", "**/.{ssh,aws}/**"],
      },
    });
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "n1",
        kind: "read",
        path: path.join(os.homedir(), "Downloads", "api.key"),
      }),
      { ok: false, code: "POLICY_DENIED", askable: false },
    );
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "n1",
        kind: "read",
        path: path.join(os.homedir(), "Downloads", ".aws", "credentials"),
      }),
      { ok: false, code: "POLICY_DENIED", askable: false },
    );
  });

  it.each([
    {
      label: "the bare denied directory",
      requestedPath: path.join(os.homedir(), ".ssh"),
      expected: { ok: false, code: "POLICY_DENIED", askable: false },
    },
    {
      label: "the denied directory with a trailing separator",
      requestedPath: `${path.join(os.homedir(), ".ssh")}/`,
      expected: { ok: false, code: "POLICY_DENIED", askable: false },
    },
    {
      label: "the bare denied directory on Windows",
      requestedPath: "C:\\Users\\me\\.ssh",
      expected: { ok: false, code: "POLICY_DENIED", askable: false },
    },
    {
      label: "a sibling sharing only the denied directory prefix",
      requestedPath: path.join(os.homedir(), ".sshrc"),
      expected: { ok: true },
    },
  ])("handles $label", ({ requestedPath, expected }) => {
    withConfig({
      n1: {
        allowReadPaths: ["/**"],
        denyPaths: ["**/.ssh/**"],
      },
    });
    expectResultFields(
      evaluateFilePolicy({ nodeId: "n1", kind: "read", path: requestedPath }),
      expected,
    );
  });

  it("denies even with ask=always (denyPaths is hard)", () => {
    withConfig({
      n1: {
        ask: "always",
        denyPaths: ["**/secrets/**"],
      },
    });
    const r = evaluateFilePolicy({
      nodeId: "n1",
      kind: "read",
      path: "/var/secrets/api.key",
    });
    expectResultFields(r, { ok: false, code: "POLICY_DENIED", askable: false });
  });
});

describe("evaluateFilePolicy — allow matching", () => {
  it("allows on matched-allow with ask=off (default)", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"] },
    });
    expect(evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/foo/bar.png" })).toEqual({
      ok: true,
      reason: "matched-allow",
      maxBytes: undefined,
      followSymlinks: false,
    });
  });

  it("propagates per-node maxBytes on matched-allow", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"], maxBytes: 1024 },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: true, maxBytes: 1024 });
  });

  it("uses kind=write to consult allowWritePaths, not allowReadPaths", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"], allowWritePaths: ["/srv/**"] },
    });
    expectResultFields(evaluateFilePolicy({ nodeId: "n1", kind: "write", path: "/srv/out.txt" }), {
      ok: true,
    });
    expectResultFields(evaluateFilePolicy({ nodeId: "n1", kind: "write", path: "/tmp/out.txt" }), {
      ok: false,
      code: "POLICY_DENIED",
    });
  });

  it("propagates followSymlinks=false by default and =true when configured", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"] },
    });
    expectResultFields(evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" }), {
      ok: true,
      followSymlinks: false,
    });

    withConfig({
      n2: { allowReadPaths: ["/tmp/**"], followSymlinks: true },
    });
    expectResultFields(evaluateFilePolicy({ nodeId: "n2", kind: "read", path: "/tmp/x" }), {
      ok: true,
      followSymlinks: true,
    });
  });

  it("expands tilde in patterns relative to homedir", () => {
    const home = os.homedir();
    withConfig({
      n1: { allowReadPaths: ["~/Screenshots/**"] },
    });
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "n1",
        kind: "read",
        path: path.join(home, "Screenshots", "shot.png"),
      }),
      { ok: true },
    );
  });

  it("matches Windows node paths without gateway-local path semantics", () => {
    withConfig({
      n1: { allowReadPaths: ["C:/Users/me/**"] },
    });
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "n1",
        kind: "read",
        path: "C:\\Users\\me\\file.txt",
      }),
      { ok: true },
    );
  });
});

describe("evaluateFilePolicy — ask modes", () => {
  it("ask=on-miss returns askable POLICY_DENIED on miss", () => {
    withConfig({
      n1: { ask: "on-miss", allowReadPaths: ["/var/log/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, {
      ok: false,
      code: "POLICY_DENIED",
      askable: true,
      askMode: "on-miss",
    });
  });

  it("ask=on-miss miss preserves transfer caps for one-time approvals", () => {
    withConfig({
      n1: {
        ask: "on-miss",
        allowReadPaths: ["/var/log/**"],
        maxBytes: 4096,
        followSymlinks: true,
      },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, {
      ok: false,
      code: "POLICY_DENIED",
      askable: true,
      askMode: "on-miss",
      maxBytes: 4096,
      followSymlinks: true,
    });
  });

  it("ask=on-miss still silent-allows on a match", () => {
    withConfig({
      n1: { ask: "on-miss", allowReadPaths: ["/tmp/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: true, reason: "matched-allow" });
  });

  it("ask=always always returns ask-always (prompt on every call)", () => {
    withConfig({
      n1: { ask: "always", allowReadPaths: ["/tmp/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: true, reason: "ask-always", askMode: "always" });
  });

  it("ask=off returns non-askable POLICY_DENIED on miss", () => {
    withConfig({
      n1: { ask: "off", allowReadPaths: ["/var/log/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: false, code: "POLICY_DENIED", askable: false });
  });

  it("invalid ask values normalize to off", () => {
    withConfig({
      n1: { ask: "sometimes", allowReadPaths: ["/var/log/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: false, askable: false });
  });
});

describe("evaluateFilePolicy — node-id resolution", () => {
  it("resolves by displayName when nodeId has no entry", () => {
    withConfig({
      "Lobster MacBook": { allowReadPaths: ["/tmp/**"] },
    });
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "node-abc-123",
        nodeDisplayName: "Lobster MacBook",
        kind: "read",
        path: "/tmp/x",
      }),
      { ok: true },
    );
  });

  it("falls back to '*' wildcard when neither id nor displayName matches", () => {
    withConfig({
      "*": { allowReadPaths: ["/tmp/**"] },
    });
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "n1",
        nodeDisplayName: "anything",
        kind: "read",
        path: "/tmp/x",
      }),
      { ok: true },
    );
  });
});

describe("literal standing grants", () => {
  it.each([
    ["asterisk", "/tmp/report-*.txt", "/tmp/report-secret.txt"],
    ["question mark", "/tmp/report-?.txt", "/tmp/report-a.txt"],
    ["character class", "/tmp/report-[ab].txt", "/tmp/report-a.txt"],
    ["brace expansion", "/tmp/report-{a,b}.txt", "/tmp/report-a.txt"],
    ["extglob", "/tmp/report-+(a|b).txt", "/tmp/report-a.txt"],
    ["POSIX backslash", "/tmp/report\\*.txt", "/tmp/report/*.txt"],
    ["Windows separators", "C:\\Temp\\report-*.txt", "C:\\Temp\\report-a.txt"],
    ["UNC path", "\\\\server\\share\\report-?.txt", "\\\\server\\share\\report-a.txt"],
  ])("keeps an approved path containing %s literal", async (_label, approvedPath, siblingPath) => {
    let captured: Record<string, unknown> | null = null;
    mutateConfigFileMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        const draft: Record<string, unknown> = {
          plugins: {
            entries: {
              "file-transfer": {
                config: { policyVersion: 2, nodes: { n1: { ask: "on-miss" } } },
              },
            },
          },
        };
        mutate(draft);
        captured = draft;
      },
    );

    await persistLiteralGrant({
      nodeId: "n1",
      command: "file.fetch",
      requestedPath: approvedPath,
      canonicalPath: approvedPath,
    });
    getRuntimeConfigMock.mockReturnValue(captured);

    expectResultFields(
      evaluateFilePolicy({
        nodeId: "n1",
        command: "file.fetch",
        kind: "read",
        path: approvedPath,
      }),
      { ok: true, reason: "matched-literal", expectedCanonicalPath: approvedPath },
    );
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "n1",
        command: "file.fetch",
        kind: "read",
        path: siblingPath,
      }),
      { ok: false, code: "POLICY_DENIED", askable: true },
    );
  });

  it("does not replay a standing approval onto another node with the same display name", async () => {
    let captured: Record<string, unknown> | null = null;
    mutateConfigFileMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        const draft: Record<string, unknown> = {
          plugins: {
            entries: {
              "file-transfer": {
                config: { policyVersion: 2, nodes: { Shared: { ask: "on-miss" } } },
              },
            },
          },
        };
        mutate(draft);
        captured = draft;
      },
    );

    await persistLiteralGrant({
      nodeId: "node-a",
      command: "file.fetch",
      requestedPath: "/tmp/report.txt",
      canonicalPath: "/tmp/report.txt",
    });
    getRuntimeConfigMock.mockReturnValue(captured);

    expectResultFields(
      evaluateFilePolicy({
        nodeId: "node-a",
        nodeDisplayName: "Shared",
        command: "file.fetch",
        kind: "read",
        path: "/tmp/report.txt",
      }),
      { ok: true, reason: "matched-literal" },
    );
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "node-b",
        nodeDisplayName: "Shared",
        command: "file.fetch",
        kind: "read",
        path: "/tmp/report.txt",
      }),
      { ok: false, code: "POLICY_DENIED", askable: true },
    );
  });

  it("dedupes the exact tuple without changing authored policy", async () => {
    let captured: Record<string, unknown> | null = null;
    mutateConfigFileMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        const draft: Record<string, unknown> = {
          plugins: {
            entries: {
              "file-transfer": {
                config: {
                  policyVersion: 2,
                  nodes: { Shared: { ask: "on-miss", denyPaths: ["**/.ssh/**"] } },
                },
              },
            },
          },
        };
        mutate(draft);
        captured = draft;
      },
    );
    const grant = {
      nodeId: "n1",
      command: "file.fetch" as const,
      requestedPath: "/tmp/x",
      canonicalPath: "/private/tmp/x",
    };
    await persistLiteralGrant(grant);
    await persistLiteralGrant(grant);

    const root = captured as unknown as {
      plugins: {
        entries: {
          "file-transfer": {
            config: {
              nodes: Record<string, unknown>;
              literalGrants: unknown[];
            };
          };
        };
      };
    };
    const config = root.plugins.entries["file-transfer"].config;
    expect(config.nodes).toEqual({
      Shared: { ask: "on-miss", denyPaths: ["**/.ssh/**"] },
    });
    expect(config.literalGrants).toEqual([grant]);
  });
});
