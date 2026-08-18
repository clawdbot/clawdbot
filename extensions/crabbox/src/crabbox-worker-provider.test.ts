import path from "node:path";
import type { WorkerProfile, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import * as doctorRuntime from "./crabbox-worker-doctor-runtime.js";
import {
  findCrabboxBinary,
  operationLeaseId,
  resolveCrabboxBinary,
} from "./crabbox-worker-profile.js";
import { createCrabboxWorkerProvider, resolveOpenClawRoot } from "./crabbox-worker-provider.js";

const OPERATION_ID = `provision:v2:${"0".repeat(64)}`;
const LEASE_ID = "cbx_6071fc2062a6";
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
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

function providerWithRawRunner(
  runCommand: CrabboxCommandRunner,
  warn?: (message: string) => void,
): WorkerProvider {
  const provider = createCrabboxWorkerProvider({
    runCommand,
    openclawRoot: OPENCLAW_ROOT,
    pathEnv: "",
    isExecutable: (candidate) => candidate === SIBLING_BINARY,
    sleep: async () => {},
    ...(warn ? { warn } : {}),
  });
  return {
    ...provider,
    provision: (profile, operationId, options) =>
      provider.provision(profile, operationId, {
        ...options,
        beginNodeEnrollment:
          options?.beginNodeEnrollment ??
          (async () => ({
            mode: "connect" as const,
            setupCode: "secret-setup-value",
            setupId: "setup-id",
            openclawVersion: "2026.8.1",
            packageSpecs: ["openclaw@2026.8.1"],
            displayName: "Cloud worker test",
            waitForDeviceId: async () => "device-1",
          })),
      }),
  };
}

function providerWithRunner(runCommand: CrabboxCommandRunner, warn?: (message: string) => void) {
  return providerWithRawRunner(async (argv, options) => {
    if (argv[1] === "config" && argv[2] === "show") {
      return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
    }
    return runCommand(argv, options);
  }, warn);
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
  it("advertises named machine classes and preserves a configured literal default", () => {
    const provider = createCrabboxWorkerProvider();

    expect(provider.supportedExecutionModes).toEqual(["worker-turn"]);
    expect(provider.listMachineOptions?.(PROFILE)).toEqual([
      {
        id: "standard",
        label: "Standard",
        description: "Cheap smoke checks and small repos",
        default: true,
      },
      { id: "fast", label: "Fast", description: "General maintainer testing" },
      { id: "large", label: "Large", description: "Broad test shards or heavy builds" },
      { id: "beast", label: "Beast", description: "High-core changed-test runs" },
    ]);
    expect(provider.listMachineOptions?.({ ...PROFILE, class: "c7a.24xlarge" })).toEqual([
      { id: "standard", label: "Standard", description: "Cheap smoke checks and small repos" },
      { id: "fast", label: "Fast", description: "General maintainer testing" },
      { id: "large", label: "Large", description: "Broad test shards or heavy builds" },
      { id: "beast", label: "Beast", description: "High-core changed-test runs" },
      {
        id: "c7a.24xlarge",
        label: "c7a.24xlarge",
        description: "Configured instance type",
        default: true,
      },
    ]);
  });

  it("returns the environment-bound node after enrollment", async () => {
    let warmed = false;
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv.includes(LEASE_ID)) {
        return commandResult({
          stdout: inspectJson({ sshFallbackPorts: [22], sshHostKey: HOST_KEY }),
        });
      }
      return warmed
        ? commandResult({
            stdout: inspectJson({ sshFallbackPorts: [22], sshHostKey: HOST_KEY }),
          })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).resolves.toEqual({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
      sharedHost: false,
    });
  });

  it("resumes a bound node without replaying the consumed setup code", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      return argv[1] === "inspect"
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult();
    });

    await expect(
      provider.provision(PROFILE, OPERATION_ID, {
        beginNodeEnrollment: async () => ({
          mode: "resume",
          deviceId: "device-bound",
          openclawVersion: "2026.8.1",
          packageSpecs: ["openclaw@2026.8.1"],
          displayName: "Bound worker",
          waitForDeviceId: async () => "device-bound",
        }),
      }),
    ).resolves.toMatchObject({ node: { deviceId: "device-bound" } });
    const setup = calls.find((call) => call.argv[1] === "run")?.options.input ?? "";
    expect(String(setup)).toContain("node run --ephemeral --display-name 'Bound worker'");
    expect(String(setup)).not.toContain("config set nodeHost.workerRuns.enabled");
    expect(String(setup)).not.toContain("setup-code");
    expect(calls.flatMap((call) => call.argv)).not.toContain("ssh");
    expect(calls.flatMap((call) => call.argv)).not.toContain("scp");
    expect(calls.flatMap((call) => call.argv)).not.toContain("rsync");
  });

  it("runs the profile setup command on the ready lease and keeps it", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    let warmed = false;
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
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
    await expect(provider.provision({ ...PROFILE, setup }, OPERATION_ID)).resolves.toMatchObject({
      leaseId: LEASE_ID,
    });
    const runCall = calls.find((call) => call.argv[1] === "run");
    expect(runCall?.argv.slice(1)).toEqual([
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
      "--script-stdin",
    ]);
    expect(runCall?.options.input).toBe(setup);
  });

  it("waits for post-setup SSH readiness and returns the final endpoint", async () => {
    const calls: string[][] = [];
    let leaseInspections = 0;
    let resolveFinalInspect!: (result: SpawnResult) => void;
    let markFinalInspectStarted!: () => void;
    const finalInspect = new Promise<SpawnResult>((resolve) => {
      resolveFinalInspect = resolve;
    });
    const finalInspectStarted = new Promise<void>((resolve) => {
      markFinalInspectStarted = resolve;
    });
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      leaseInspections += 1;
      if (leaseInspections === 1) {
        return commandResult({
          stdout: inspectJson({
            sshFallbackPorts: [22],
            sshHost: "before-setup.example.test",
            sshHostKey: HOST_KEY,
          }),
        });
      }
      if (leaseInspections === 2) {
        return commandResult({
          stdout: inspectJson({
            ready: false,
            sshFallbackPorts: [22],
            sshHost: "restarting.example.test",
            sshHostKey: HOST_KEY,
          }),
        });
      }
      markFinalInspectStarted();
      return await finalInspect;
    });

    const provision = provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID);
    let settled = false;
    void provision.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await finalInspectStarted;
    expect(settled).toBe(false);
    resolveFinalInspect(
      commandResult({
        stdout: inspectJson({
          sshFallbackPorts: [22, 2222],
          sshHost: "after-setup.example.test",
          sshHostKey: "ssh-ed25519 BBBB",
          sshPort: "2200",
        }),
      }),
    );

    await expect(provision).resolves.toMatchObject({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
      sharedHost: false,
    });
    expect(calls.map((argv) => argv[1])).toEqual([
      "warmup",
      "inspect",
      "run",
      "inspect",
      "inspect",
      "run",
      "inspect",
    ]);
  });

  it("leaves a lease live when it disappears from post-setup inspection", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run" || argv[1] === "stop") {
        return commandResult();
      }
      inspections += 1;
      return inspections === 1
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toThrow("disappeared while waiting for SSH readiness");
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "run", "inspect"]);
  });

  it("re-attests security on the fresh post-setup inspect before polling", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run" || argv[1] === "stop") {
        return commandResult();
      }
      inspections += 1;
      return commandResult({
        stdout: inspectJson({
          providerMetadata: { instanceProfileAttached: inspections > 1 },
          ready: inspections === 1,
          sshHostKey: HOST_KEY,
        }),
      });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "run", "inspect", "stop"]);
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
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
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
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toThrow("Crabbox setup could not start");
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("rejects an effective AWS instance profile after authoritative lease absence", async () => {
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
        if (argv[1] === "stop") {
          throw new Error("authoritative absence must not run cleanup");
        }
        return commandResult({
          stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
        });
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["config", "inspect"]);
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
        if (argv[1] === "stop") {
          throw new Error("authoritative absence must not run cleanup");
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
      provider.provision({ ...PROFILE, provider: "AWS" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["config", "inspect"]);
  });

  it("cleans a committed fixed lease before making an AWS profile rejection permanent", async () => {
    const calls: string[][] = [];
    let creates = 0;
    let inspectTimeout = true;
    let profileRejected = false;
    let live = false;
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      if (argv[1] === "config") {
        return commandResult({
          stdout: JSON.stringify({
            aws: { instanceProfile: profileRejected ? "worker-role" : "" },
          }),
        });
      }
      if (argv[1] === "warmup") {
        if (!live) {
          creates += 1;
          live = true;
        }
        return commandResult();
      }
      if (argv[1] === "inspect") {
        if (inspectTimeout) {
          inspectTimeout = false;
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "stop") {
        live = false;
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    };

    await expect(
      providerWithRawRunner(runCommand).provision(PROFILE, OPERATION_ID),
    ).rejects.toThrow("inspect did not exit normally (timeout)");
    expect(live).toBe(true);
    profileRejected = true;

    await expect(
      providerWithRawRunner(runCommand).provision(PROFILE, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(creates).toBe(1);
    expect(live).toBe(false);
    expect(calls.map((argv) => argv[1])).toEqual([
      "config",
      "warmup",
      "inspect",
      "config",
      "inspect",
      "stop",
    ]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("cleans the exact fixed ID after malformed reconciliation inspection", async () => {
    const calls: string[][] = [];
    let live = true;
    const provider = providerWithRawRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "config") {
        return commandResult({
          stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
        });
      }
      if (argv[1] === "inspect") {
        return commandResult({ stdout: "{" });
      }
      if (argv[1] === "stop") {
        live = false;
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(live).toBe(false);
    expect(calls.map((argv) => argv[1])).toEqual(["config", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it.each(["inspect", "stop"] as const)(
    "keeps AWS profile rejection transient while exact-ID %s is indeterminate",
    async (failurePoint) => {
      const calls: string[][] = [];
      let live = true;
      const provider = providerWithRawRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({
            stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
          });
        }
        if (argv[1] === "inspect") {
          return failurePoint === "inspect"
            ? commandResult({ code: null, killed: true, termination: "timeout" })
            : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
        }
        if (argv[1] === "stop") {
          if (failurePoint === "stop") {
            return commandResult({ code: null, killed: true, termination: "timeout" });
          }
          live = false;
          return commandResult();
        }
        throw new Error(`unexpected Crabbox command: ${argv[1]}`);
      });

      const error = await provider
        .provision(PROFILE, OPERATION_ID)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toMatchObject({ code: "invalid_profile" });
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain(`cleanup is indeterminate during ${failurePoint}`);
      expect(message).toContain("Crabbox AWS instance profile must be empty for cloud workers");
      expect(message.length).toBeLessThanOrEqual(512);
      expect(live).toBe(true);
      expect(calls.map((argv) => argv[1])).toEqual(
        failurePoint === "inspect" ? ["config", "inspect"] : ["config", "inspect", "stop"],
      );
    },
  );

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

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    });
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it.each([
    {
      state: "pending-metadata then ready-safe",
      inspections: [
        { providerMetadata: undefined, ready: false },
        {
          providerMetadata: { instanceProfileAttached: false },
          ready: true,
          sshHostKey: HOST_KEY,
        },
      ],
      expectedError: null,
      expectedCommands: ["warmup", "inspect", "inspect", "run", "inspect"],
    },
    {
      state: "pending-forbidden",
      inspections: [
        {
          providerMetadata: { instanceProfileAttached: true },
          ready: false,
        },
      ],
      expectedError: "Crabbox AWS inspect must attest that no instance profile is attached",
      expectedCommands: ["warmup", "inspect", "stop"],
    },
    {
      state: "ready-metadata-missing",
      inspections: [{ providerMetadata: undefined, ready: true, sshHostKey: HOST_KEY }],
      expectedError: "Crabbox AWS inspect must attest that no instance profile is attached",
      expectedCommands: ["warmup", "inspect", "stop"],
    },
  ])(
    "enforces AWS instance-profile attestation across the $state sequence",
    async ({ inspections, expectedError, expectedCommands }) => {
      const calls: string[][] = [];
      let inspectionIndex = 0;
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          const inspection = inspections[inspectionIndex] ?? inspections.at(-1);
          if (!inspection) {
            throw new Error("missing inspection fixture");
          }
          inspectionIndex += 1;
          return commandResult({ stdout: inspectJson(inspection) });
        }
        return commandResult();
      });

      const provision = provider.provision(PROFILE, OPERATION_ID);
      if (expectedError) {
        await expect(provision).rejects.toMatchObject({
          code: "invalid_profile",
          message: expectedError,
        });
      } else {
        await expect(provision).resolves.toMatchObject({ leaseId: LEASE_ID });
      }
      expect(calls.map((argv) => argv[1])).toEqual(expectedCommands);
    },
  );

  it.each([
    {
      field: "provider metadata",
      overrides: { providerMetadata: { instanceProfileAttached: "no" } },
    },
    { field: "Tailscale state", overrides: { tailscale: null } },
  ])("stops a fixed lease with malformed $field", async ({ overrides }) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "stop") {
        return commandResult();
      }
      return commandResult({ stdout: inspectJson(overrides) });
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringMatching(/Crabbox inspect returned invalid/u),
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it.each([
    ["invalid JSON", commandResult({ stdout: "{" }), "Crabbox inspect returned invalid JSON"],
    [
      "expected-id mismatch",
      commandResult({ stdout: inspectJson({ id: "cbx_ffffffffffff" }) }),
      "Crabbox inspect returned a different lease id",
    ],
  ])("stops a fixed lease on permanent %s", async (_name, inspectResult, message) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "stop") {
        return commandResult();
      }
      return argv[1] === "inspect" ? inspectResult : commandResult();
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message,
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("stops a fixed lease that has Tailscale state", async () => {
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

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox cloud worker lease must not have Tailscale enabled",
    });
    expect(calls.some((argv) => argv[1] === "warmup")).toBe(true);
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it("rejects a blank profile setup command", async () => {
    const provider = providerWithRunner(async () => commandResult());
    await expect(provider.provision({ ...PROFILE, setup: "  " }, "provision:x")).rejects.toThrow(
      "Crabbox profile setup must be a non-empty command string",
    );
  });

  it.each([
    [`provision:v2:${"0".repeat(64)}`, "cbx_6071fc2062a6"],
    [`provision:v2:${"a".repeat(64)}`, "cbx_d75d2e596dde"],
  ])("derives canonical fixed lease id for %s", (operationId, expected) => {
    expect(operationLeaseId(operationId)).toBe(expected);
    expect(operationLeaseId(operationId)).toMatch(/^cbx_[a-f0-9]{12}$/u);
  });

  it("rejects a non-boolean desktop profile setting", async () => {
    const provider = providerWithRunner(async () => commandResult());
    await expect(provider.provision({ ...PROFILE, desktop: "yes" }, OPERATION_ID)).rejects.toThrow(
      "Crabbox profile desktop must be a boolean",
    );
  });

  it("rejects desktop profiles after node transport convergence", async () => {
    const provider = providerWithRunner(async () => commandResult());

    await expect(
      provider.provision({ ...PROFILE, desktop: true }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox desktop profiles are unavailable after node transport convergence",
    });
  });

  it("runs one fixed warmup, ignores its output, and inspects only the canonical id", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      return argv[1] === "warmup"
        ? commandResult({ stdout: "warmup completed without a lease token\n" })
        : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).resolves.toMatchObject({
      leaseId: LEASE_ID,
    });
    expect(calls).toHaveLength(4);
    expect(calls[0]?.argv).toEqual([
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
      "--lease-id",
      LEASE_ID,
      "--slug",
      expect.stringMatching(/^openclaw-[a-f0-9]{32}$/u),
      "--keep=true",
    ]);
    expect(calls[0]?.options).toEqual({
      timeoutMs: 240_000,
      maxOutputBytes: 65_536,
      killProcessTree: true,
    });
    expect(calls[1]?.argv).toEqual([
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
    expect(calls[2]?.argv[1]).toBe("run");
    expect(String(calls[2]?.options.input)).toContain("openclaw@2026.8.1");
    expect(String(calls[2]?.options.input)).toContain("'OpenClaw 2026.8.1'|'OpenClaw 2026.8.1 '*");
    expect(String(calls[2]?.options.input)).toContain(
      'npx --yes --package "$package_spec" -- openclaw',
    );
    expect(String(calls[2]?.options.input)).toContain(
      "OpenClaw worker bootstrap could not install Gateway version 2026.8.1",
    );
    expect(String(calls[2]?.options.input)).toContain(
      'connect --target-file "$setup_code_file" --ephemeral',
    );
    expect(String(calls[2]?.options.input)).toContain("setsid -f sh -c");
    expect(String(calls[2]?.options.input)).not.toContain("config set nodeHost.workerRuns.enabled");
    expect(String(calls[2]?.options.input)).not.toContain("nohup");
    expect(String(calls[2]?.options.input)).not.toContain("secret-setup-value");
    expect(calls[2]?.options.env).toMatchObject({
      CRABBOX_WORKER_SETUP_CODE: "secret-setup-value",
    });
    expect(calls[2]?.argv).toEqual(
      expect.arrayContaining(["--allow-env", "CRABBOX_WORKER_SETUP_CODE"]),
    );
    expect(calls[2]?.argv.join(" ")).not.toContain("setup-code");
    expect(calls[3]?.argv[1]).toBe("inspect");
  });

  it("overrides the configured class for one provision operation", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return argv[1] === "warmup"
        ? commandResult()
        : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
    });

    await provider.provision(PROFILE, OPERATION_ID, { machineClass: "c7a.24xlarge" });

    const warmup = calls.find((argv) => argv[1] === "warmup");
    expect(warmup?.slice(warmup.indexOf("--class"), warmup.indexOf("--class") + 2)).toEqual([
      "--class",
      "c7a.24xlarge",
    ]);
  });

  it.each([" ", "x".repeat(129)])(
    "rejects an invalid per-operation machine class before allocation",
    async (machineClass) => {
      const runCommand = vi.fn(async () => commandResult());
      const provider = providerWithRunner(runCommand);

      await expect(
        provider.provision(PROFILE, OPERATION_ID, { machineClass }),
      ).rejects.toMatchObject({ code: "invalid_profile" });
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it("replays a committed timed-out warmup through a fresh provider instance", async () => {
    const calls: string[][] = [];
    const live = new Set<string>();
    let creates = 0;
    let loseFirstReply = true;
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      const idFlag = argv.indexOf("--id");
      const leaseIdFlag = argv.indexOf("--lease-id");
      const id = argv[idFlag >= 0 ? idFlag + 1 : leaseIdFlag + 1] ?? "";
      if (argv[1] === "warmup") {
        if (!live.has(id)) {
          creates += 1;
          live.add(id);
        }
        if (loseFirstReply) {
          loseFirstReply = false;
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        return commandResult();
      }
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson({ id, sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      if (argv[1] === "stop") {
        live.delete(id);
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    };

    await expect(providerWithRunner(runCommand).provision(PROFILE, OPERATION_ID)).rejects.toThrow(
      "did not exit normally (timeout)",
    );
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);

    const restarted = providerWithRunner(runCommand);
    const lease = await restarted.provision(PROFILE, OPERATION_ID);
    await restarted.destroy({ leaseId: lease.leaseId, profile: PROFILE });

    expect(creates).toBe(1);
    expect(lease.leaseId).toBe(LEASE_ID);
    expect(live.size).toBe(0);
    expect(calls.filter((argv) => argv[1] === "warmup")).toHaveLength(2);
    expect(calls.filter((argv) => argv[1] === "inspect")).toEqual([
      expect.arrayContaining(["--id", LEASE_ID]),
      expect.arrayContaining(["--id", LEASE_ID]),
    ]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("keeps a committed lease live after inspect timeout and adopts it on replay", async () => {
    const calls: string[][] = [];
    const live = new Set<string>();
    let creates = 0;
    let inspections = 0;
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      const idFlag = argv.indexOf("--id");
      const leaseIdFlag = argv.indexOf("--lease-id");
      const id = argv[idFlag >= 0 ? idFlag + 1 : leaseIdFlag + 1] ?? "";
      if (argv[1] === "warmup") {
        if (!live.has(id)) {
          creates += 1;
          live.add(id);
        }
        return commandResult();
      }
      if (argv[1] === "inspect") {
        inspections += 1;
        return inspections === 1
          ? commandResult({ code: null, killed: true, termination: "timeout" })
          : commandResult({ stdout: inspectJson({ id, sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      if (argv[1] === "stop") {
        live.delete(id);
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    };

    await expect(providerWithRunner(runCommand).provision(PROFILE, OPERATION_ID)).rejects.toThrow(
      "did not exit normally (timeout)",
    );
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
    expect(live).toEqual(new Set([LEASE_ID]));

    const restarted = providerWithRunner(runCommand);
    const lease = await restarted.provision(PROFILE, OPERATION_ID);
    expect(lease.leaseId).toBe(LEASE_ID);
    expect(creates).toBe(1);
    expect(live).toEqual(new Set([LEASE_ID]));

    await restarted.destroy({ leaseId: lease.leaseId, profile: PROFILE });
    expect(live.size).toBe(0);
    expect(calls.map((argv) => argv[1])).toEqual([
      "warmup",
      "inspect",
      "warmup",
      "inspect",
      "run",
      "inspect",
      "stop",
    ]);
  });

  it.each([
    [
      "spawn failure",
      async (): Promise<SpawnResult> => {
        throw new Error("spawn failed");
      },
      "Crabbox inspect could not start",
    ],
    [
      "non-authoritative CLI failure",
      async (): Promise<SpawnResult> => commandResult({ code: 1, stderr: "provider unavailable" }),
      "Crabbox inspect failed with exit code 1",
    ],
  ])("leaves the fixed lease live after transient %s", async (_name, failure, message) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return await failure();
      }
      if (argv[1] === "stop") {
        throw new Error("transient inspection must not stop the lease");
      }
      return commandResult();
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: expect.stringContaining(message) });
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
  });

  it("keeps authoritative absence after warmup retryable and un-stopped", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
      }
      if (argv[1] === "stop") {
        throw new Error("authoritative absence must not tombstone the fixed ID");
      }
      return commandResult();
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "Crabbox warmup lease was not found during inspection",
    });
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
  });

  it.each([
    ["old backend", 2, "provider=aws does not support fixed idempotent lease IDs"],
    ["old CLI", 2, "unknown flag: --lease-id"],
    ["intent drift", 4, "lease_id_conflict: lease is bound to another create intent"],
    ["terminal reuse", 4, "lease_id_conflict: fixed lease is terminal and cannot be replayed"],
  ])("treats %s as a permanent provider rejection", async (_name, code, stderr) => {
    const provider = providerWithRunner(async () => commandResult({ code, stderr }));

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("keeps unresolved direct AWS inventory convergence retryable", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult({
        code: 4,
        stderr:
          "lease_id_conflict: fixed AWS lease has an unresolved launch attempt; retry after provider inventory converges",
      });
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
  });

  it("rejects legacy unleased provision state before invoking Crabbox", async () => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });

    await expect(provider.provision(PROFILE, `provision:${"0".repeat(64)}`)).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("cannot be replayed safely"),
    });
    expect(invoked).toBe(false);
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
        provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
      ).rejects.toThrow("exceeded its provider deadline");
    } finally {
      now.mockRestore();
    }
    expect(calls.map((argv) => argv[1])).toEqual(["config", "warmup", "inspect"]);
  });

  it("leaves the fixed lease live when readiness polling fails transiently", async () => {
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

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toThrow(
      "readiness probe failed",
    );
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "inspect"]);
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
      provider.provision({ ...PROFILE, provider: "missing-provider" }, OPERATION_ID),
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
      provider.provision({ ...PROFILE, provider: "wandb" }, OPERATION_ID),
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
      provider.provision({ ...PROFILE, provider: "windows-sandbox" }, OPERATION_ID),
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
      provider.provision({ ...PROFILE, provider: "vast" }, OPERATION_ID),
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
      provider.provision({ ...PROFILE, provider: "mxc" }, OPERATION_ID),
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

  it.each([
    { idleTimeout: "1s", idleTimeoutMs: 1_000, intervalMs: 500 },
    { idleTimeout: "2s", idleTimeoutMs: 2_000, intervalMs: 1_000 },
    { idleTimeout: "5s", idleTimeoutMs: 5_000, intervalMs: 2_500 },
    { idleTimeout: "12s", idleTimeoutMs: 12_000, intervalMs: 5_000 },
    { idleTimeout: "30s", idleTimeoutMs: 30_000, intervalMs: 10_000 },
    { idleTimeout: "6m", idleTimeoutMs: 360_000, intervalMs: 60_000 },
  ])(
    "heartbeats an active lease every $intervalMs ms for idleTimeout=$idleTimeout",
    async ({ idleTimeout, idleTimeoutMs, intervalMs }) => {
      vi.useFakeTimers();
      const calls: string[][] = [];
      const profile = { ...PROFILE, idleTimeout };
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        return argv[1] === "inspect"
          ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
          : commandResult();
      });
      const heartbeatCalls = () => calls.filter((argv) => argv[1] === "heartbeat");

      try {
        await expect(provider.provision(profile, OPERATION_ID)).resolves.toMatchObject({
          leaseId: LEASE_ID,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(heartbeatCalls()).toEqual([
          [
            SIBLING_BINARY,
            "heartbeat",
            "--provider",
            "aws",
            "--id",
            LEASE_ID,
            "--idle-timeout",
            idleTimeout,
            "--json",
          ],
        ]);

        await vi.advanceTimersByTimeAsync(intervalMs - 1);
        expect(heartbeatCalls()).toHaveLength(1);
        expect(intervalMs).toBeLessThan(idleTimeoutMs);
        await vi.advanceTimersByTimeAsync(1);
        expect(heartbeatCalls()).toHaveLength(2);
      } finally {
        await provider.destroy(lifecycleLease(LEASE_ID, profile));
        vi.useRealTimers();
      }
    },
  );

  it("aborts heartbeat before provider teardown and never reschedules it", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    let finishStop!: () => void;
    const stopPending = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const provider = providerWithRunner(async (argv, options) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson() });
      }
      if (argv[1] === "heartbeat") {
        return await new Promise<SpawnResult>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve(commandResult({ code: null, termination: "signal" })),
            { once: true },
          );
        });
      }
      if (argv[1] === "stop") {
        await stopPending;
      }
      return commandResult();
    });
    const lease = lifecycleLease();

    try {
      await provider.inspect(lease);
      void vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1),
      );

      const destroy = provider.destroy(lease);
      await vi.waitFor(() => expect(calls.some((argv) => argv[1] === "stop")).toBe(true));
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1);
      finishStop();
      await destroy;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1);
    } finally {
      finishStop();
      vi.useRealTimers();
    }
  });

  it("warns once and disables heartbeat when the Crabbox command is unavailable", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const warnings: string[] = [];
    const provider = providerWithRunner(
      async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] === "heartbeat") {
          return commandResult({ code: 2, stderr: "unexpected argument heartbeat" });
        }
        return commandResult();
      },
      (message) => warnings.push(message),
    );
    const lease = lifecycleLease();

    try {
      await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
      await vi.advanceTimersByTimeAsync(0);
      await provider.inspect(lease);
      await vi.advanceTimersByTimeAsync(180_000);

      expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1);
      expect(warnings).toEqual([
        `Crabbox heartbeat is unavailable for worker lease ${LEASE_ID}; upgrade Crabbox to a release that includes \`crabbox heartbeat\` (added after v0.43.0); cloud worker machines may be reaped after 60m of coordinator-idle time`,
      ]);
    } finally {
      await provider.destroy(lease);
      vi.useRealTimers();
    }
  });

  it("keeps heartbeat transport failures out of lifecycle operations and retries", async () => {
    vi.useFakeTimers();
    let heartbeatAttempts = 0;
    const warnings: string[] = [];
    const provider = providerWithRunner(
      async (argv) => {
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] === "heartbeat" && heartbeatAttempts++ === 0) {
          throw new Error("transport unavailable");
        }
        return commandResult();
      },
      (message) => warnings.push(message),
    );
    const lease = lifecycleLease();

    try {
      await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeatAttempts).toBe(1);
      expect(warnings).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(heartbeatAttempts).toBe(2);
      expect(warnings).toHaveLength(1);
    } finally {
      await provider.destroy(lease);
      vi.useRealTimers();
    }
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

  it("distinguishes executable discovery from the dispatch fallback", () => {
    const explicitBinary = path.resolve(path.sep, "custom", "crabbox");

    expect(
      findCrabboxBinary({
        explicit: explicitBinary,
        openclawRoot: OPENCLAW_ROOT,
        isExecutable: () => false,
      }),
    ).toBeUndefined();
    expect(
      findCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: path.resolve(path.sep, "not-executable"),
        isExecutable: () => false,
      }),
    ).toBeUndefined();
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

describe("Crabbox version probe", () => {
  it.each([
    { output: "0.41.1\n", expected: { status: "supported", version: "0.41.1" } },
    { output: "crabbox 0.41.6\n", expected: { status: "supported", version: "0.41.6" } },
    { output: "0.40.9\n", expected: { status: "outdated", version: "0.40.9" } },
  ])("classifies $output", async ({ output, expected }) => {
    const run = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockResolvedValue(commandResult({ stdout: output }));
    try {
      await expect(doctorRuntime.probeCrabboxVersion("/opt/crabbox")).resolves.toEqual(expected);
      expect(run).toHaveBeenCalledWith(
        ["/opt/crabbox", "--version"],
        expect.objectContaining({ timeoutMs: 2_000, killProcessTree: true }),
      );
    } finally {
      run.mockRestore();
    }
  });

  it("turns timeout into an indeterminate result", async () => {
    const run = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockResolvedValue(commandResult({ code: 124, termination: "timeout" }));
    try {
      await expect(doctorRuntime.probeCrabboxVersion("/opt/crabbox")).resolves.toEqual({
        status: "indeterminate",
        reason: "version command timed out after 2000 ms",
      });
    } finally {
      run.mockRestore();
    }
  });
});
