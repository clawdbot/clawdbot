import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the plugin-sdk runtime-config surface so we can drive the policy
// reader from the test without booting a gateway. mutateConfigFile is also
// mocked so persistAllowAlways tests can assert what would have been written
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
const { evaluateFilePolicy, persistAllowAlways } = await import("./policy.js");

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
            config: { nodes: fileTransfer },
          },
        },
      },
    });
  }
}

describe("evaluateFilePolicy — default deny", () => {
  it("returns NO_POLICY when no plugin config block is present", () => {
    getRuntimeConfigMock.mockReturnValue({});
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expect(r).toMatchObject({ ok: false, code: "NO_POLICY", askable: false });
  });

  it("returns NO_POLICY when plugin policy block is missing", () => {
    getRuntimeConfigMock.mockReturnValue({ plugins: { entries: { "file-transfer": {} } } });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expect(r).toMatchObject({ ok: false, code: "NO_POLICY" });
  });

  it("returns NO_POLICY when no entry exists for the node and no '*' fallback", () => {
    withConfig({ "other-node": { allowReadPaths: ["/tmp/**"] } });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expect(r).toMatchObject({ ok: false, code: "NO_POLICY" });
  });

  it("prefers the current runtime config over a stale passed plugin config", () => {
    getRuntimeConfigMock.mockReturnValue({
      plugins: {
        entries: {
          "file-transfer": {
            config: {
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
    expect(r).toMatchObject({ ok: true, reason: "matched-allow" });
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
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED", askable: false });
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
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED" });
  });

  it("rejects bare '..'", () => {
    withConfig({
      n1: { allowReadPaths: ["/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: ".." });
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED" });
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
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED", askable: false });
    expect(r.ok ? "" : r.reason).toMatch(/deny/);
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
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED", askable: false });
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
    expect(r).toMatchObject({ ok: true, maxBytes: 1024 });
  });

  it("uses kind=write to consult allowWritePaths, not allowReadPaths", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"], allowWritePaths: ["/srv/**"] },
    });
    expect(evaluateFilePolicy({ nodeId: "n1", kind: "write", path: "/srv/out.txt" })).toMatchObject(
      { ok: true },
    );
    expect(evaluateFilePolicy({ nodeId: "n1", kind: "write", path: "/tmp/out.txt" })).toMatchObject(
      { ok: false, code: "POLICY_DENIED" },
    );
  });

  it("propagates followSymlinks=false by default and =true when configured", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"] },
    });
    expect(evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" })).toMatchObject({
      ok: true,
      followSymlinks: false,
    });

    withConfig({
      n2: { allowReadPaths: ["/tmp/**"], followSymlinks: true },
    });
    expect(evaluateFilePolicy({ nodeId: "n2", kind: "read", path: "/tmp/x" })).toMatchObject({
      ok: true,
      followSymlinks: true,
    });
  });

  it("expands tilde in patterns relative to homedir", () => {
    const home = os.homedir();
    withConfig({
      n1: { allowReadPaths: ["~/Screenshots/**"] },
    });
    expect(
      evaluateFilePolicy({
        nodeId: "n1",
        kind: "read",
        path: path.join(home, "Screenshots", "shot.png"),
      }),
    ).toMatchObject({ ok: true });
  });

  it("matches Windows node paths without gateway-local path semantics", () => {
    withConfig({
      n1: { allowReadPaths: ["C:/Users/me/**"] },
    });
    expect(
      evaluateFilePolicy({
        nodeId: "n1",
        kind: "read",
        path: "C:\\Users\\me\\file.txt",
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("evaluateFilePolicy — ask modes", () => {
  it("ask=on-miss returns askable POLICY_DENIED on miss", () => {
    withConfig({
      n1: { ask: "on-miss", allowReadPaths: ["/var/log/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expect(r).toMatchObject({
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
    expect(r).toMatchObject({
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
    expect(r).toMatchObject({ ok: true, reason: "matched-allow" });
  });

  it("ask=always always returns ask-always (prompt on every call)", () => {
    withConfig({
      n1: { ask: "always", allowReadPaths: ["/tmp/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expect(r).toMatchObject({ ok: true, reason: "ask-always", askMode: "always" });
  });

  it("ask=off returns non-askable POLICY_DENIED on miss", () => {
    withConfig({
      n1: { ask: "off", allowReadPaths: ["/var/log/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED", askable: false });
  });

  it("invalid ask values normalize to off", () => {
    withConfig({
      n1: { ask: "sometimes", allowReadPaths: ["/var/log/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expect(r).toMatchObject({ ok: false, askable: false });
  });
});

describe("evaluateFilePolicy — node-id resolution", () => {
  it("resolves by displayName when nodeId has no entry", () => {
    withConfig({
      "Lobster MacBook": { allowReadPaths: ["/tmp/**"] },
    });
    expect(
      evaluateFilePolicy({
        nodeId: "node-abc-123",
        nodeDisplayName: "Lobster MacBook",
        kind: "read",
        path: "/tmp/x",
      }),
    ).toMatchObject({ ok: true });
  });

  it("falls back to '*' wildcard when neither id nor displayName matches", () => {
    withConfig({
      "*": { allowReadPaths: ["/tmp/**"] },
    });
    expect(
      evaluateFilePolicy({
        nodeId: "n1",
        nodeDisplayName: "anything",
        kind: "read",
        path: "/tmp/x",
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("persistAllowAlways", () => {
  it("appends path to allowReadPaths under the existing matching key", async () => {
    let captured: Record<string, unknown> | null = null;
    mutateConfigFileMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        const draft: Record<string, unknown> = {
          plugins: {
            entries: {
              "file-transfer": {
                config: { nodes: { n1: { allowReadPaths: ["/tmp/**"] } } },
              },
            },
          },
        };
        mutate(draft);
        captured = draft;
      },
    );
    await persistAllowAlways({ nodeId: "n1", kind: "read", path: "/srv/added.png" });

    expect(mutateConfigFileMock).toHaveBeenCalledOnce();
    // Drill back into the captured draft to assert the added path.
    const root = captured as unknown as {
      plugins: {
        entries: {
          "file-transfer": {
            config: { nodes: Record<string, { allowReadPaths: string[] }> };
          };
        };
      };
    };
    expect(root.plugins.entries["file-transfer"].config.nodes.n1.allowReadPaths).toContain(
      "/srv/added.png",
    );
  });

  it("creates a new node entry keyed by displayName when no entry exists", async () => {
    let captured: Record<string, unknown> | null = null;
    mutateConfigFileMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        const draft: Record<string, unknown> = {};
        mutate(draft);
        captured = draft;
      },
    );

    await persistAllowAlways({
      nodeId: "n1",
      nodeDisplayName: "Lobster",
      kind: "write",
      path: "/srv/out.txt",
    });

    const root = captured as unknown as {
      plugins: {
        entries: {
          "file-transfer": {
            config: { nodes: Record<string, { allowWritePaths: string[] }> };
          };
        };
      };
    };
    expect(root.plugins.entries["file-transfer"].config.nodes["Lobster"].allowWritePaths).toContain(
      "/srv/out.txt",
    );
  });

  it("never persists under the '*' wildcard even when '*' is the matching key", async () => {
    let captured: Record<string, unknown> | null = null;
    mutateConfigFileMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        const draft: Record<string, unknown> = {
          plugins: {
            entries: {
              "file-transfer": {
                config: { nodes: { "*": { allowReadPaths: ["/var/log/**"] } } },
              },
            },
          },
        };
        mutate(draft);
        captured = draft;
      },
    );

    await persistAllowAlways({
      nodeId: "n1",
      nodeDisplayName: "Lobster",
      kind: "read",
      path: "/srv/added.png",
    });

    const root = captured as unknown as {
      plugins: {
        entries: {
          "file-transfer": {
            config: { nodes: Record<string, { allowReadPaths?: string[] }> };
          };
        };
      };
    };
    // The "*" entry must not have been mutated.
    expect(root.plugins.entries["file-transfer"].config.nodes["*"].allowReadPaths).toEqual([
      "/var/log/**",
    ]);
    // A new entry keyed by displayName (not "*") must hold the new path.
    expect(root.plugins.entries["file-transfer"].config.nodes["Lobster"].allowReadPaths).toEqual([
      "/srv/added.png",
    ]);
  });

  it("rejects unsafe keys (__proto__, prototype, constructor) that would mutate prototype chain", async () => {
    mutateConfigFileMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        const draft: Record<string, unknown> = {};
        mutate(draft);
      },
    );

    await expect(
      persistAllowAlways({
        nodeId: "n1",
        nodeDisplayName: "__proto__",
        kind: "read",
        path: "/etc/passwd",
      }),
    ).rejects.toThrow(/unsafe key.*__proto__/);

    await expect(
      persistAllowAlways({
        nodeId: "constructor",
        kind: "read",
        path: "/etc/passwd",
      }),
    ).rejects.toThrow(/unsafe key.*constructor/);
  });

  it("dedupes when path already present", async () => {
    let captured: Record<string, unknown> | null = null;
    mutateConfigFileMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        const draft: Record<string, unknown> = {
          plugins: {
            entries: {
              "file-transfer": {
                config: { nodes: { n1: { allowReadPaths: ["/tmp/x"] } } },
              },
            },
          },
        };
        mutate(draft);
        captured = draft;
      },
    );
    await persistAllowAlways({ nodeId: "n1", kind: "read", path: "/tmp/x" });

    const root = captured as unknown as {
      plugins: {
        entries: {
          "file-transfer": {
            config: { nodes: Record<string, { allowReadPaths: string[] }> };
          };
        };
      };
    };
    const list = root.plugins.entries["file-transfer"].config.nodes.n1.allowReadPaths;
    expect(list.filter((p) => p === "/tmp/x").length).toBe(1);
  });
});
