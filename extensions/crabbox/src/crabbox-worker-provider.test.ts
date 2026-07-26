import path from "node:path";
import type { WorkerProfile } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveCrabboxBinary } from "./crabbox-worker-profile.js";
import { createCrabboxWorkerProvider, resolveOpenClawRoot } from "./crabbox-worker-provider.js";

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

type CrabboxWorkerProviderDependencies = NonNullable<
  Parameters<typeof createCrabboxWorkerProvider>[0]
>;
type CrabboxCommandRunner = NonNullable<CrabboxWorkerProviderDependencies["runCommand"]>;

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
    providerMetadata: { instanceProfileAttached: false },
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
    runCommand: async (argv, options) => {
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
      }
      return runCommand(argv, options);
    },
    openclawRoot: OPENCLAW_ROOT,
    pathEnv: "",
    isExecutable: (candidate) => candidate === SIBLING_BINARY,
    sleep: async () => {},
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

  it("runs the profile setup command on the ready lease and keeps it", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      return warmed || argv.includes(LEASE_ID)
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    const setup = "command -v node || install-node";
    await expect(
      provider.provision({ ...PROFILE, setup }, "provision:setup-run"),
    ).resolves.toMatchObject({ leaseId: LEASE_ID });
    const runCall = calls.find((argv) => argv[1] === "run");
    expect(runCall?.slice(1)).toEqual([
      "run",
      "--provider",
      "aws",
      "--network",
      "public",
      "--tailscale=false",
      "--id",
      LEASE_ID,
      "--keep=true",
      "--no-sync",
      "--",
      "bash",
      "-lc",
      setup,
    ]);
  });

  it("stops the lease when the profile setup command fails", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv[1] === "run") {
        return commandResult({ code: 7, stderr: "apt exploded" });
      }
      if (argv[1] === "stop") {
        return commandResult();
      }
      return warmed || argv.includes(LEASE_ID)
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, "provision:setup-fail"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("Crabbox setup failed with exit code 7"),
    });
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it("stops the lease when the profile setup command cannot start", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv[1] === "run") {
        throw new Error("spawn unavailable");
      }
      if (argv[1] === "stop") {
        return commandResult();
      }
      return warmed || argv.includes(LEASE_ID)
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, "provision:setup-spawn"),
    ).rejects.toThrow("Crabbox setup could not start");
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("rejects an effective AWS instance profile before allocating", async () => {
    const calls: string[][] = [];
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({
            code: 4,
            stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
          });
        }
        return commandResult({
          stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
        });
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
    });

    await expect(provider.provision(PROFILE, "provision:instance-profile")).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["inspect", "config"]);
  });

  it("applies AWS credential policy to case-insensitive provider input", async () => {
    const calls: string[][] = [];
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({
            code: 4,
            stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
          });
        }
        return commandResult({
          stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
        });
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "AWS" }, "provision:uppercase-aws"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["inspect", "config"]);
    expect(calls[0]).toContain("aws");
  });

  it("stops a replay lease before rejecting an effective AWS instance profile", async () => {
    const calls: string[][] = [];
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson({ ready: false }) });
        }
        if (argv[1] === "config") {
          return commandResult({
            stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
          });
        }
        return commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
    });

    await expect(
      provider.provision(PROFILE, "provision:instance-profile-replay"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["inspect", "config", "stop"]);
  });

  it("stops an AWS lease when provider metadata reports an instance profile", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
        }
        if (argv[1] === "warmup") {
          warmed = true;
          return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
        }
        if (argv[1] === "inspect") {
          return warmed || argv.includes(LEASE_ID)
            ? commandResult({
                stdout: inspectJson({
                  providerMetadata: { instanceProfileAttached: true },
                  sshHostKey: HOST_KEY,
                }),
              })
            : commandResult({
                code: 4,
                stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
              });
        }
        return commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
      sleep: async () => {},
    });

    await expect(
      provider.provision(PROFILE, "provision:instance-profile-attached"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    });
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it("stops a forbidden replay lease before polling for SSH readiness", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({
          stdout: inspectJson({
            providerMetadata: { instanceProfileAttached: true },
            ready: false,
          }),
        });
      }
      return commandResult();
    });

    await expect(provider.provision(PROFILE, "provision:forbidden-replay")).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["inspect", "stop"]);
  });

  it("stops an AWS lease when provider metadata cannot attest the instance profile state", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({
          stdout: inspectJson({ providerMetadata: undefined, sshHostKey: HOST_KEY }),
        });
      }
      return commandResult();
    });

    await expect(
      provider.provision(PROFILE, "provision:instance-profile-unknown"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it.each([
    {
      field: "provider metadata",
      overrides: { providerMetadata: { instanceProfileAttached: "no" } },
    },
    { field: "Tailscale state", overrides: { tailscale: null } },
  ])("stops a replay lease with malformed $field", async ({ overrides }) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "stop") {
        return commandResult();
      }
      return commandResult({ stdout: inspectJson(overrides) });
    });

    await expect(provider.provision(PROFILE, "provision:malformed-replay")).rejects.toThrow(
      /Crabbox inspect returned invalid/u,
    );
    expect(calls.map((argv) => argv[1])).toEqual(["inspect", "stop"]);
  });

  it("stops a newly allocated lease when its inspect result is malformed", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv[1] === "stop") {
        return commandResult();
      }
      if (warmed) {
        return commandResult({ stdout: inspectJson({ providerMetadata: [] }) });
      }
      return commandResult({
        code: 4,
        stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
      });
    });

    await expect(provider.provision(PROFILE, "provision:malformed-new")).rejects.toThrow(
      "Crabbox inspect returned invalid provider metadata",
    );
    expect(calls.map((argv) => argv[1])).toEqual(["inspect", "warmup", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("stops a replay lease that already has Tailscale state", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({
          stdout: inspectJson({ sshHostKey: HOST_KEY, tailscale: { enabled: true } }),
        });
      }
      return commandResult();
    });

    await expect(provider.provision(PROFILE, "provision:tailscale-replay")).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox cloud worker lease must not have Tailscale enabled",
    });
    expect(calls.some((argv) => argv[1] === "warmup")).toBe(false);
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it("rejects a blank profile setup command", async () => {
    const provider = providerWithRunner(async () => commandResult());
    await expect(provider.provision({ ...PROFILE, setup: "  " }, "provision:x")).rejects.toThrow(
      "Crabbox profile setup must be a non-empty command string",
    );
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
      "--network",
      "public",
      "--id",
      expect.stringMatching(/^openclaw-[a-f0-9]{32}$/u),
      "--json",
    ]);
    expect(calls[1]?.argv).toEqual([
      SIBLING_BINARY,
      "warmup",
      "--provider",
      "aws",
      "--network",
      "public",
      "--tailscale=false",
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
      "--network",
      "public",
      "--id",
      LEASE_ID,
      "--json",
    ]);
    expect(calls[3]?.argv).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("stops the operation slug when successful warmup output omits the lease id", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult({ stdout: "warmup complete\n" });
      }
      if (argv[1] === "stop") {
        return commandResult();
      }
      if (argv[1] === "config") {
        return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
      }
      return commandResult({
        code: 4,
        stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
      });
    });

    await expect(provider.provision(PROFILE, "provision:missing-id")).rejects.toThrow(
      "Crabbox warmup did not return a lease id",
    );
    expect(calls.at(-1)).toEqual([
      SIBLING_BINARY,
      "stop",
      "--provider",
      "aws",
      "--id",
      expect.stringMatching(/^openclaw-[a-f0-9]{32}$/u),
    ]);
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
      "--network",
      "public",
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

  it("waits for a replayed operation lease to become SSH-ready", async () => {
    let inspections = 0;
    const provider = providerWithRunner(async () => {
      inspections += 1;
      return commandResult({
        stdout: inspectJson({ ready: inspections > 1, sshHostKey: HOST_KEY }),
      });
    });

    await expect(provider.provision(PROFILE, "provision:operation-pending")).resolves.toMatchObject(
      {
        leaseId: LEASE_ID,
      },
    );
    expect(inspections).toBe(2);
  });

  it("keeps readiness polling out of the setup timeout budget", async () => {
    const calls: string[][] = [];
    let nowMs = 1_000;
    let inspections = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
        }
        if (argv[1] === "inspect") {
          inspections += 1;
          return commandResult({
            stdout: inspectJson({ ready: inspections > 1, sshHostKey: HOST_KEY }),
          });
        }
        return commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
      sleep: async () => {
        nowMs += 290_001;
      },
    });

    try {
      await expect(
        provider.provision({ ...PROFILE, setup: "install-node" }, "provision:readiness-budget"),
      ).rejects.toThrow("exceeded its provider deadline");
    } finally {
      now.mockRestore();
    }
    expect(calls.map((argv) => argv[1])).toEqual(["inspect", "config", "stop"]);
  });

  it("stops a replayed operation lease when readiness polling fails", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        inspections += 1;
        return inspections === 1
          ? commandResult({ stdout: inspectJson({ ready: false }) })
          : commandResult({ code: 1, stderr: "readiness probe failed" });
      }
      return commandResult();
    });

    await expect(
      provider.provision(PROFILE, "provision:operation-readiness-failure"),
    ).rejects.toThrow("readiness probe failed");
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
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
      [binary, "inspect", "--provider", "coder", "--network", "public", "--id", LEASE_ID, "--json"],
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
      [
        SIBLING_BINARY,
        "inspect",
        "--provider",
        "aws",
        "--network",
        "public",
        "--id",
        LEASE_ID,
        "--json",
      ],
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

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
