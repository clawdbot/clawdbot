import path from "node:path";
import type { WorkerProfile } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it } from "vitest";
import {
  createCrabboxWorkerProvider,
  type CrabboxCommandRunner,
  resolveCrabboxBinary,
  resolveOpenClawRoot,
} from "./crabbox-worker-provider.js";

const LEASE_ID = "cbx_012345abcdef";
const FALLBACK_LEASE_ID = "cbx_20260711123456123456";
const TESTBOX_LEASE_ID = "tbx_Test-123";
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const HOST_KEY_ERROR =
  "Crabbox inspect does not expose the SSH host key required by the worker provider contract";
const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");
const INSPECT_FAILURE_PREFIX = "Crabbox inspect failed with exit code 2: ";
const PROFILE = {
  provider: "aws",
  class: "standard",
  ttl: "24h",
  idleTimeout: "60m",
};

function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: LEASE_ID,
    state: "running",
    host: "fallback.example.test",
    sshHost: "worker.example.test",
    sshPort: "2222",
    sshUser: "openclaw",
    sshKey: "/tmp/crabbox-worker-key",
    ready: true,
    ...overrides,
  });
}

function lifecycleLease(leaseId = LEASE_ID, profile: WorkerProfile = PROFILE) {
  return { leaseId, profile };
}

function providerWithRunner(runCommand: CrabboxCommandRunner) {
  return createCrabboxWorkerProvider({
    runCommand,
    openclawRoot: OPENCLAW_ROOT,
    pathEnv: "",
    isExecutable: (candidate) => candidate === SIBLING_BINARY,
  });
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("Crabbox worker provider", () => {
  it("returns a pinned endpoint when inspect exposes provisioned host-key material", async () => {
    let warmed = false;
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv.includes(LEASE_ID)) {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      return warmed
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    await expect(provider.provision(PROFILE, "provision:host-pin")).resolves.toEqual({
      leaseId: LEASE_ID,
      ssh: {
        host: "worker.example.test",
        port: 2222,
        user: "openclaw",
        hostKey: HOST_KEY,
        keyRef: {
          source: "file",
          provider: "crabbox",
          id: `/leases/${LEASE_ID}/identity`,
        },
      },
    });
  });

  it("stops a newly provisioned lease when inspect cannot supply a host key", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const runCommand: CrabboxCommandRunner = async (argv, options) => {
      calls.push({ argv, options });
      const command = argv[1];
      if (command === "warmup") {
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (command === "inspect" && argv.includes(LEASE_ID)) {
        return commandResult({ stdout: inspectJson() });
      }
      return commandResult({
        code: 4,
        stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
      });
    };
    const provider = providerWithRunner(runCommand);

    await expect(provider.provision(PROFILE, "provision:operation-123")).rejects.toMatchObject({
      code: "invalid_profile",
      message: HOST_KEY_ERROR,
    });
    expect(calls).toHaveLength(4);
    expect(calls[0]?.argv).toEqual([
      SIBLING_BINARY,
      "inspect",
      "--provider",
      "aws",
      "--id",
      expect.stringMatching(/^openclaw-[a-f0-9]{32}$/u),
      "--json",
    ]);
    expect(calls[1]?.argv).toEqual([
      SIBLING_BINARY,
      "warmup",
      "--provider",
      "aws",
      "--class",
      "standard",
      "--ttl",
      "24h",
      "--idle-timeout",
      "60m",
      "--slug",
      expect.stringMatching(/^openclaw-[a-f0-9]{32}$/u),
      "--keep=true",
    ]);
    expect(calls[1]?.options).toEqual({
      timeoutMs: 240_000,
      maxOutputBytes: 65_536,
      killProcessTree: true,
    });
    expect(calls[2]?.argv).toEqual([
      SIBLING_BINARY,
      "inspect",
      "--provider",
      "aws",
      "--id",
      LEASE_ID,
      "--json",
    ]);
    expect(calls[3]?.argv).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("stops an adopted operation lease when inspect cannot supply a host key", async () => {
    const calls: string[][] = [];
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      return commandResult({ stdout: inspectJson() });
    };
    const provider = providerWithRunner(runCommand);

    await expect(provider.provision(PROFILE, "provision:operation-replay")).rejects.toMatchObject({
      code: "invalid_profile",
      message: HOST_KEY_ERROR,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      SIBLING_BINARY,
      "inspect",
      "--provider",
      "aws",
      "--id",
      expect.stringMatching(/^openclaw-[a-f0-9]{32}$/u),
      "--json",
    ]);
    expect(calls[1]).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("stops Crabbox's timestamp fallback lease id when its host key is unavailable", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult({ stdout: `leased ${FALLBACK_LEASE_ID} slug=test\n` });
      }
      if (argv.includes(FALLBACK_LEASE_ID)) {
        return commandResult({ stdout: inspectJson({ id: FALLBACK_LEASE_ID }) });
      }
      return commandResult({
        code: 4,
        stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
      });
    });

    await expect(provider.provision(PROFILE, "provision:fallback-id")).rejects.toMatchObject({
      code: "invalid_profile",
      message: HOST_KEY_ERROR,
    });
    expect(calls.at(-1)).toEqual([
      SIBLING_BINARY,
      "stop",
      "--provider",
      "aws",
      "--id",
      FALLBACK_LEASE_ID,
    ]);
  });

  it("stops a lease whose Crabbox backend returns an unsupported id", async () => {
    const calls: string[][] = [];
    const staticLeaseId = "--custom-static-worker";
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult({ stdout: `leased ${staticLeaseId} slug=test\n` });
      }
      if (argv[1] === "stop") {
        return commandResult();
      }
      return commandResult({
        code: 4,
        stderr: `static lease not found: ${argv[argv.indexOf("--id") + 1]}`,
      });
    };
    const provider = providerWithRunner(runCommand);

    await expect(
      provider.provision({ ...PROFILE, provider: "ssh" }, "provision:static-worker"),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(calls.at(-1)).toEqual([
      SIBLING_BINARY,
      "stop",
      "--provider",
      "ssh",
      "--id",
      staticLeaseId,
    ]);
  });

  it.each([
    {
      provider: "e2b",
      missing: (id: string) =>
        commandResult({ code: 4, stderr: `e2b sandbox "${id}" is not claimed by Crabbox` }),
    },
    {
      provider: "coder",
      missing: (id: string) =>
        commandResult({ code: 5, stderr: `coder workspace "${id}" not found` }),
    },
  ])(
    "cleans $provider after its authoritative slug miss cannot yield a host key",
    async ({ provider, missing }) => {
      let warmed = false;
      let stopped = false;
      const runCommand: CrabboxCommandRunner = async (argv) => {
        if (argv[1] === "warmup") {
          warmed = true;
          return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
        }
        if (argv[1] === "stop") {
          stopped = true;
          return commandResult();
        }
        if (argv.includes(LEASE_ID)) {
          return commandResult({ stdout: inspectJson() });
        }
        return missing(argv[argv.indexOf("--id") + 1] ?? "");
      };
      const crabboxProvider = providerWithRunner(runCommand);

      await expect(
        crabboxProvider.provision({ ...PROFILE, provider }, `provision:${provider}`),
      ).rejects.toMatchObject({
        code: "invalid_profile",
        message: HOST_KEY_ERROR,
      });
      expect(warmed).toBe(true);
      expect(stopped).toBe(true);
    },
  );

  it("cleans a terminal operation lease before provisioning its replacement", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      if (argv[1] === "stop") {
        return commandResult();
      }
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      return commandResult({
        stdout: inspectJson(warmed ? {} : { ready: false, state: "stopped" }),
      });
    };
    const provider = providerWithRunner(runCommand);

    await expect(provider.provision(PROFILE, "provision:replace-terminal")).rejects.toMatchObject({
      code: "invalid_profile",
      message: HOST_KEY_ERROR,
    });
    expect(calls.map((argv) => argv[1])).toEqual(["inspect", "stop", "warmup", "inspect", "stop"]);
  });

  it("stops a delegated Testbox lease that cannot expose an SSH endpoint", async () => {
    const calls: string[][] = [];
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult({ stdout: `leased ${TESTBOX_LEASE_ID} slug=test\n` });
      }
      if (argv[1] === "inspect" && argv.includes(TESTBOX_LEASE_ID)) {
        return commandResult({
          stdout: inspectJson({
            id: TESTBOX_LEASE_ID,
            host: "",
            sshHost: "",
            sshKey: "",
            sshPort: "",
            sshUser: "",
          }),
        });
      }
      if (argv[1] === "stop") {
        return commandResult();
      }
      return commandResult({
        code: 4,
        stderr: `unknown blacksmith testbox "${argv[argv.indexOf("--id") + 1]}"`,
      });
    };
    const provider = providerWithRunner(runCommand);

    await expect(
      provider.provision(
        { ...PROFILE, provider: "blacksmith-testbox" },
        "provision:testbox-operation",
      ),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
    expect(calls.at(-1)).toEqual([
      SIBLING_BINARY,
      "stop",
      "--provider",
      "blacksmith-testbox",
      "--id",
      TESTBOX_LEASE_ID,
    ]);
  });

  it("rejects a replayed operation lease until it becomes SSH-ready", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({ stdout: inspectJson({ ready: false }) }),
    );

    await expect(provider.provision(PROFILE, "provision:operation-pending")).rejects.toThrow(
      "lease is not ready",
    );
  });

  it.each([
    { profile: {}, message: "provider" },
    { profile: { ...PROFILE, provider: " " }, message: "provider" },
    { profile: { ...PROFILE, class: 4 }, message: "class" },
    { profile: { ...PROFILE, ttl: "" }, message: "ttl" },
    { profile: { ...PROFILE, ttl: "garbage" }, message: "positive Go duration" },
    { profile: { ...PROFILE, ttl: "0.1ns" }, message: "positive Go duration" },
    {
      profile: { ...PROFILE, ttl: "999999999999999999999h" },
      message: "positive Go duration",
    },
    { profile: { ...PROFILE, idleTimeout: false }, message: "idleTimeout" },
    { profile: { ...PROFILE, idleTimeout: "0s" }, message: "positive Go duration" },
    { profile: { ...PROFILE, binary: " " }, message: "binary" },
    { profile: { ...PROFILE, binary: "crabbox" }, message: "absolute path" },
    { profile: { ...PROFILE, typo: true }, message: "unknown" },
  ])("rejects an invalid profile ($message)", async ({ profile, message }) => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });

    await expect(provider.provision(profile, "provision:invalid")).rejects.toThrow(message);
    await expect(provider.provision(profile, "provision:invalid")).rejects.toMatchObject({
      code: "invalid_profile",
    });
    expect(invoked).toBe(false);
  });

  it("rejects a provider unknown to the Crabbox binary as an invalid profile", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({ code: 2, stderr: 'unknown provider "missing-provider"' }),
    );

    await expect(
      provider.provision(
        { ...PROFILE, provider: "missing-provider" },
        "provision:unknown-provider",
      ),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a Crabbox backend without warmup support as an invalid profile", async () => {
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "warmup") {
        return commandResult({ code: 2, stderr: "provider=wandb does not support warmup" });
      }
      return commandResult({
        code: 4,
        stderr: `wandb sandbox "${argv[argv.indexOf("--id") + 1]}" has no matching local ownership claim`,
      });
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "wandb" }, "provision:unsupported-provider"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a Crabbox backend without persistent status as an invalid profile", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({
        code: 2,
        stderr:
          "provider=windows-sandbox does not expose persistent status; close the Windows Sandbox window",
      }),
    );

    await expect(
      provider.provision(
        { ...PROFILE, provider: "windows-sandbox" },
        "provision:nonpersistent-provider",
      ),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a machine class unsupported by the selected Crabbox backend", async () => {
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "warmup") {
        return commandResult({
          code: 2,
          stderr: "--class is not supported for provider=vast; use --vast-gpu-name",
        });
      }
      return commandResult({
        code: 4,
        stderr: `lease/instance not found: ${argv[argv.indexOf("--id") + 1]}`,
      });
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "vast" }, "provision:unsupported-class"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a one-shot Crabbox backend as an invalid worker profile", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({
        code: 2,
        stderr: "provider=mxc is one-shot and does not support status",
      }),
    );

    await expect(
      provider.provision({ ...PROFILE, provider: "mxc" }, "provision:one-shot-provider"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("routes lifecycle calls from the passed profile context", async () => {
    const binary = path.resolve(path.sep, "custom", "crabbox");
    const calls: string[][] = [];
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        return argv[1] === "inspect" ? commandResult({ stdout: inspectJson() }) : commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: () => false,
    });
    const lease = lifecycleLease(LEASE_ID, { ...PROFILE, binary, provider: "coder" });

    await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    expect(calls).toEqual([
      [binary, "inspect", "--provider", "coder", "--id", LEASE_ID, "--json"],
      [binary, "stop", "--provider", "coder", "--id", LEASE_ID],
    ]);
  });

  it("resolves its lease-bound identity marker through current inspect output", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
    });
    if (!provider.resolveSshIdentity) {
      throw new Error("expected Crabbox identity resolver");
    }

    await expect(
      provider.resolveSshIdentity({
        leaseId: LEASE_ID,
        profile: PROFILE,
        keyRef: {
          source: "file",
          provider: "crabbox",
          id: `/leases/${LEASE_ID}/identity`,
        },
      }),
    ).resolves.toEqual({ kind: "path", path: "/tmp/crabbox-worker-key" });
    expect(calls).toEqual([
      [SIBLING_BINARY, "inspect", "--provider", "aws", "--id", LEASE_ID, "--json"],
    ]);
  });

  it("rejects a Crabbox identity marker for another lease before invoking the CLI", async () => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });
    if (!provider.resolveSshIdentity) {
      throw new Error("expected Crabbox identity resolver");
    }

    await expect(
      provider.resolveSshIdentity({
        leaseId: LEASE_ID,
        profile: PROFILE,
        keyRef: { source: "file", provider: "crabbox", id: "/leases/cbx_other/identity" },
      }),
    ).rejects.toThrow("does not match its lease");
    expect(invoked).toBe(false);
  });

  it("rejects non-Crabbox lifecycle lease ids before invoking the CLI", async () => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });
    const lease = lifecycleLease("lease:not-crabbox");

    await expect(provider.inspect(lease)).rejects.toThrow("lease id is invalid");
    await expect(provider.destroy(lease)).rejects.toThrow("lease id is invalid");
    expect(invoked).toBe(false);
  });

  it.each([
    { state: "running", ready: true, expected: "active" },
    { state: "provisioning", ready: false, expected: "active" },
    { state: "stopped", ready: false, expected: "destroyed" },
    { state: "released", ready: false, expected: "destroyed" },
    { state: "deleted", ready: false, expected: "destroyed" },
    { state: "destroyed", ready: false, expected: "destroyed" },
    { state: "deleting", ready: false, expected: "active" },
    { state: "failed", ready: false, expected: "active" },
  ])("maps inspect state $state to $expected", async ({ state, ready, expected }) => {
    const provider = providerWithRunner(async () =>
      commandResult({ stdout: inspectJson({ state, ready }) }),
    );

    await expect(provider.inspect(lifecycleLease())).resolves.toStrictEqual({
      status: expected,
    });
  });

  it("maps only authoritative lease absence to unknown", async () => {
    const missing = providerWithRunner(async () =>
      commandResult({ code: 4, stderr: `lease/droplet not found: ${LEASE_ID}` }),
    );
    const authFailure = providerWithRunner(async () =>
      commandResult({
        code: 4,
        stderr: `credential profile not found while inspecting lease ${LEASE_ID}`,
      }),
    );
    const noLongerExists = providerWithRunner(async () =>
      commandResult({ code: 4, stderr: `unikraftcloud lease ${LEASE_ID} no longer exists` }),
    );
    const ambiguousVisibility = providerWithRunner(async () =>
      commandResult({
        code: 4,
        stderr: `nomad job for lease ${LEASE_ID} is missing or inaccessible`,
      }),
    );
    const cliMissing = providerWithRunner(async () => {
      throw new Error("spawn ENOENT");
    });

    const lease = lifecycleLease();
    await expect(missing.inspect(lease)).resolves.toStrictEqual({ status: "unknown" });
    await expect(noLongerExists.inspect(lease)).resolves.toStrictEqual({ status: "unknown" });
    await expect(authFailure.inspect(lease)).rejects.toThrow("inspect failed with exit code 4");
    await expect(ambiguousVisibility.inspect(lease)).rejects.toThrow(
      "inspect failed with exit code 4",
    );
    await expect(cliMissing.inspect(lease)).rejects.toThrow("inspect could not start");
  });

  it("rejects malformed inspect endpoint fields as transient CLI errors", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({ stdout: inspectJson({ sshPort: true }) }),
    );

    await expect(provider.inspect(lifecycleLease())).rejects.toThrow("invalid sshPort");
  });

  it("bounds and redacts CLI failure details", async () => {
    const secret = ["sk", "abcdefghijklmnop"].join("-");
    const provider = providerWithRunner(async () =>
      commandResult({
        code: 2,
        stderr: `${secret} ${"failure ".repeat(200)}`,
        stdout: "stdout must not replace stderr",
      }),
    );

    const error = await provider.inspect(lifecycleLease()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).not.toContain(secret);
    expect(message).not.toContain("stdout must not replace stderr");
    expect(message).toHaveLength(INSPECT_FAILURE_PREFIX.length + 512);
  });

  it("preserves UTF-16 boundaries in provider failure details", async () => {
    const prefix = "x".repeat(511);
    const provider = providerWithRunner(async () =>
      commandResult({ code: 2, stderr: `${prefix}😀after` }),
    );

    const error = await provider.inspect(lifecycleLease()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe(`${INSPECT_FAILURE_PREFIX}${prefix}`);
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it("keeps a complete boundary pair when falling back to stdout", async () => {
    const detail = `${"x".repeat(510)}😀`;
    const provider = providerWithRunner(async () =>
      commandResult({ code: 2, stdout: `${detail}after` }),
    );

    const error = await provider.inspect(lifecycleLease()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe(`${INSPECT_FAILURE_PREFIX}${detail}`);
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it("destroys absent and already-stopped leases idempotently", async () => {
    const calls: string[][] = [];
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      return calls.length === 1
        ? commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` })
        : commandResult({ code: 4, stderr: `lease ${LEASE_ID} already stopped` });
    };
    const provider = providerWithRunner(runCommand);

    const lease = lifecycleLease();
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    expect(calls).toEqual([
      [SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID],
      [SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID],
    ]);
  });
});

describe("Crabbox binary resolution", () => {
  it("prefers explicit, then sibling, then PATH, then the bare command", () => {
    const toolsDir = path.resolve(path.sep, "tools");
    const pathBinary = path.join(toolsDir, "crabbox");
    const relativePathBinary = path.resolve("relative-tools", "crabbox");
    const explicitBinary = path.resolve(path.sep, "custom", "crabbox");

    expect(
      resolveCrabboxBinary({
        explicit: explicitBinary,
        openclawRoot: OPENCLAW_ROOT,
        isExecutable: () => false,
      }),
    ).toBe(explicitBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: toolsDir,
        isExecutable: (candidate) => candidate === SIBLING_BINARY || candidate === pathBinary,
      }),
    ).toBe(SIBLING_BINARY);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: [path.resolve(path.sep, "not-executable"), toolsDir].join(path.delimiter),
        isExecutable: (candidate) => candidate === pathBinary,
      }),
    ).toBe(pathBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: "relative-tools",
        isExecutable: (candidate) => candidate === relativePathBinary,
      }),
    ).toBe(relativePathBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: path.resolve(path.sep, "not-executable"),
        isExecutable: () => false,
      }),
    ).toBe("crabbox");
  });

  it("derives the package root from source and bundled plugin roots", () => {
    expect(resolveOpenClawRoot(path.join(OPENCLAW_ROOT, "extensions", "crabbox"))).toBe(
      OPENCLAW_ROOT,
    );
    expect(resolveOpenClawRoot(path.join(OPENCLAW_ROOT, "dist", "extensions", "crabbox"))).toBe(
      OPENCLAW_ROOT,
    );
  });
});
