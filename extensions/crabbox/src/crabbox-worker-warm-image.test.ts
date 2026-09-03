import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { operationLeaseId, operationSlug } from "./crabbox-worker-profile.js";
import {
  listCrabboxWarmImages,
  recoverCrabboxWarmImageCapture,
} from "./crabbox-worker-warm-image-store.js";
import {
  captureWarmImage,
  commandResult,
  createWarmProvider,
  provisionWarmProfile,
  CHECKPOINT_ID,
  CLASSLESS_PROFILE,
  LEASE_ID,
  OPERATION_ID,
  PROFILE,
  tempDirs,
} from "./crabbox-worker-warm-image.test-support.js";

describe("Crabbox profile warm images", () => {
  it("reuses captured images across managers, setup environment values, and setup environment order", async () => {
    const profile = { ...PROFILE, setup: "install-node", setupEnv: ["WARM_B", "WARM_A"] };
    vi.stubEnv("WARM_A", "first-secret");
    vi.stubEnv("WARM_B", "second-secret");
    const initial = createWarmProvider();
    await captureWarmImage(initial.provider, profile);
    expect(initial.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);

    const identical = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(identical.provider, {
      ...profile,
      setupEnv: [...profile.setupEnv],
    });
    expect(identical.calls.some(({ argv }) => argv[2] === "create")).toBe(false);

    vi.stubEnv("WARM_A", "changed-secret");
    const changedValues = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(changedValues.provider, profile);
    expect(changedValues.calls.some(({ argv }) => argv[2] === "create")).toBe(false);

    const reordered = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(reordered.provider, { ...profile, setupEnv: ["WARM_A", "WARM_B"] });
    expect(reordered.calls.some(({ argv }) => argv[2] === "create")).toBe(false);
  });

  it("captures distinct images when setup, machine class, desktop, provider, or setup environment names change", async () => {
    const profile = { ...PROFILE, setup: "install-node", setupEnv: ["WARM_B", "WARM_A"] };
    vi.stubEnv("WARM_A", "first-secret");
    vi.stubEnv("WARM_B", "second-secret");
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider, profile);

    for (const [index, changed] of [
      { ...profile, setup: "install-other-node" },
      { ...profile, class: "fast" },
      { ...profile, desktop: true },
      { ...profile, provider: "hetzner" },
      { ...profile, setupEnv: ["WARM_A"] },
    ].entries()) {
      calls.length = 0;
      await captureWarmImage(provider, changed, `provision:v2:${String(index + 1).repeat(64)}`);
      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    }
  });

  describe.each([
    {
      sizing: "omitted",
      configuredClass: undefined,
      placementClass: undefined,
      effectiveClass: undefined,
    },
    {
      sizing: "configured",
      configuredClass: "standard",
      placementClass: undefined,
      effectiveClass: "standard",
    },
    {
      sizing: "placement",
      configuredClass: undefined,
      placementClass: "fast",
      effectiveClass: "fast",
    },
    {
      sizing: "overridden",
      configuredClass: "standard",
      placementClass: "fast",
      effectiveClass: "fast",
    },
  ])("warm policy with $sizing sizing", ({ configuredClass, placementClass, effectiveClass }) => {
    it.each([
      { choice: "default", warmImage: undefined, setupEnv: undefined, capturesKnownClass: true },
      {
        choice: "default, empty setupEnv",
        warmImage: undefined,
        setupEnv: [],
        capturesKnownClass: true,
      },
      {
        choice: "default, setupEnv",
        warmImage: undefined,
        setupEnv: ["WARM_POLICY_INPUT"],
        capturesKnownClass: false,
      },
      { choice: "false", warmImage: false, setupEnv: undefined, capturesKnownClass: false },
      {
        choice: "false, setupEnv",
        warmImage: false,
        setupEnv: ["WARM_POLICY_INPUT"],
        capturesKnownClass: false,
      },
      { choice: "true", warmImage: true, setupEnv: undefined, capturesKnownClass: true },
      {
        choice: "true, setupEnv",
        warmImage: true,
        setupEnv: ["WARM_POLICY_INPUT"],
        capturesKnownClass: true,
      },
    ])(
      "applies $choice through provision and teardown",
      async ({ warmImage, setupEnv, capturesKnownClass }) => {
        const { provider, calls, stateDir } = createWarmProvider();
        const profile = {
          provider: "aws",
          ttl: "24h",
          idleTimeout: "60m",
          ...(configuredClass === undefined ? {} : { class: configuredClass }),
          ...(warmImage === undefined ? {} : { warmImage }),
          ...(setupEnv === undefined ? {} : { setup: "install-node", setupEnv }),
        };
        vi.stubEnv("WARM_POLICY_INPUT", "fixture-value");
        if (warmImage === true && effectiveClass === undefined) {
          await expect(
            provisionWarmProfile(provider, profile, OPERATION_ID, placementClass),
          ).rejects.toMatchObject({ code: "invalid_profile" });
          expect(calls).toEqual([]);
          return;
        }
        const lease = await provisionWarmProfile(provider, profile, OPERATION_ID, placementClass);
        // Teardown uses enrolled sizing and declared setup names, never their host values.
        vi.stubEnv("WARM_POLICY_INPUT", undefined);
        await provider.destroy({ leaseId: lease.leaseId, profile });
        const warmup = calls.find(({ argv }) => argv[1] === "warmup")?.argv;
        expect(warmup).toBeDefined();
        if (effectiveClass === undefined) {
          expect(calls.flatMap(({ argv }) => argv)).not.toContain("--class");
        } else {
          expect(warmup?.[warmup.indexOf("--class") + 1]).toBe(effectiveClass);
          expect(warmup?.filter((arg) => arg === "--class")).toHaveLength(1);
        }
        const captures = effectiveClass !== undefined && capturesKnownClass;
        expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(captures ? 1 : 0);
        if (!captures) {
          expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
          expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
        }
        expect(calls.at(-1)?.argv[1]).toBe("stop");
      },
    );
  });

  it.each(["standard", undefined])(
    "never invokes checkpoint commands with warm images disabled and class %s",
    async (machineClass) => {
      const { provider, calls } = createWarmProvider();
      const profile = {
        ...CLASSLESS_PROFILE,
        ...(machineClass ? { class: machineClass } : {}),
        warmImage: false,
      };
      const lease = await provisionWarmProfile(provider, profile);

      await provider.destroy({ leaseId: lease.leaseId, profile });

      expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
      expect(calls.at(-1)?.argv[1]).toBe("stop");
      // Even without capture, the stop command owns termination after its timer fires.
      expect(provider.resolveDestroyTimeoutMs?.(profile)).toBeGreaterThan(
        calls.at(-1)!.options.timeoutMs,
      );
    },
  );

  it("scrubs every worker identity and workspace before capturing an enrolled lease", async () => {
    const { provider, calls } = createWarmProvider();
    const lease = await provisionWarmProfile(provider);
    calls.length = 0;

    await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });

    expect(calls.map(({ argv }) => argv.slice(1, argv[1] === "checkpoint" ? 3 : 2))).toEqual([
      ["run"],
      ["checkpoint", "create"],
      ["stop"],
    ]);
    const scrub = calls[0];
    expect(scrub?.argv).toContain("--script-stdin");
    expect(scrub?.options.input).toContain("$HOME/.openclaw/cloud-workers");

    expect(scrub?.options.input).toContain('rm -rf "$worker_root"');
    expect(scrub?.options.input).toContain('rm -rf "$HOME/.openclaw-worker/workspaces"');
    // Capture phases ride a full crabbox run/snapshot round trip; 60s starves
    // them under coordinator latency (live-measured on AWS 2026-08-26).
    expect(scrub?.options.timeoutMs).toBe(180_000);
    expect(calls[1]?.options.timeoutMs).toBe(180_000);
    expect(provider.resolveDestroyTimeoutMs?.(PROFILE)).toBeGreaterThanOrEqual(
      calls.reduce((total, call) => total + call.options.timeoutMs, 0),
    );
    const home = tempDirs.make("openclaw-crabbox-warm-scrub-");
    const workspace = path.join(
      home,
      ".openclaw",
      "cloud-workers",
      LEASE_ID,
      "node-host",
      "gateway",
      "workspaces",
      "session",
    );
    const npmCache = path.join(home, ".npm", "cached-package");
    const sshWorkspace = path.join(home, ".openclaw-worker", "workspaces", "session");
    const bundle = path.join(home, ".openclaw-worker", "bundle-hash", "index.js");
    const gitSeed = path.join(home, ".openclaw-worker", "git-seeds", "gateway", "seed", "file");
    const bin = path.join(home, "bin");
    const workdir = path.join(home, "crabbox-workdir");
    const envFile = path.join(workdir, ".crabbox", "env", "forwarded.env");
    const scrubScript = path.join(workdir, ".crabbox", "scripts", "scrub.sh");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(npmCache), { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.mkdirSync(path.dirname(scrubScript), { recursive: true });
    fs.writeFileSync(envFile, "CRABBOX_WORKER_BOOTSTRAP_TOKEN=synthetic-expired-token");
    fs.writeFileSync(scrubScript, String(scrub?.options.input));
    fs.writeFileSync(path.join(workspace, "private.txt"), "session workspace bytes");
    fs.writeFileSync(npmCache, "reusable npm package");
    for (const file of [path.join(sshWorkspace, "private.txt"), bundle, gitSeed]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, file);
    }
    const runtime = path.join(home, ".openclaw-worker", "node-runtimes", "a".repeat(64));
    fs.mkdirSync(runtime, { recursive: true });
    const state = path.join(home, ".openclaw", "cloud-workers", LEASE_ID);
    fs.symlinkSync(runtime, path.join(state, "runtime"));
    const node =
      process.platform === "linux"
        ? spawn(
            process.execPath,
            [
              "-e",
              'process.title = "openclaw-node"; process.stdout.write("ready"); setInterval(() => {}, 60000);',
            ],
            {
              cwd: runtime,
              env: { ...process.env, OPENCLAW_STATE_DIR: state },
              detached: true,
              stdio: ["ignore", "pipe", "ignore"],
            },
          )
        : undefined;
    const nodeClosed = node ? once(node, "close") : undefined;
    if (node) {
      await once(node.stdout!, "data");
      fs.writeFileSync(path.join(state, "node.pid"), String(node.pid));
    }
    const stopNode = async () => {
      if (node?.pid && node.exitCode === null && node.signalCode === null) {
        try {
          process.kill(-node.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
        await nodeClosed;
      }
    };
    try {
      execFileSync("/bin/bash", [scrubScript], {
        cwd: workdir,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });
      if (nodeClosed) {
        expect((await nodeClosed)[1]).toBe("SIGTERM");
      }
    } finally {
      await stopNode();
    }
    expect(fs.existsSync(runtime)).toBe(true);
    expect(fs.existsSync(path.join(home, ".openclaw", "cloud-workers"))).toBe(false);
    expect(fs.existsSync(sshWorkspace)).toBe(false);
    expect(fs.existsSync(envFile)).toBe(false);
    expect(fs.existsSync(scrubScript)).toBe(false);
    expect(fs.readFileSync(npmCache, "utf8")).toBe("reusable npm package");
    expect(fs.readFileSync(bundle, "utf8")).toBe(bundle);
    expect(fs.readFileSync(gitSeed, "utf8")).toBe(gitSeed);
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.mkdirSync(path.dirname(scrubScript), { recursive: true });
    fs.writeFileSync(envFile, "CRABBOX_WORKER_BOOTSTRAP_TOKEN=synthetic-expired-token");
    fs.writeFileSync(scrubScript, String(scrub?.options.input));
    fs.writeFileSync(
      path.join(bin, "rm"),
      '#!/bin/sh\ncase "$*" in *".crabbox/env"*) exit 7;; esac\nexec /bin/rm "$@"\n',
      { mode: 0o700 },
    );
    expect(() =>
      execFileSync("/bin/bash", [scrubScript], {
        cwd: workdir,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      }),
    ).toThrow();
    expect(fs.existsSync(envFile)).toBe(true);
    expect(calls[1]?.argv.slice(1)).toEqual([
      "checkpoint",
      "create",
      "--provider",
      "aws",
      "--id",
      LEASE_ID,
      "--mode",
      "native",
      "--wait",
      "--json",
    ]);
    calls.length = 0;
    await provisionWarmProfile(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
    expect(calls.some(({ argv }) => argv[2] === "inspect")).toBe(true);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
  });

  it("captures and reuses machine0 images with native ACTIVE state", async () => {
    const profile = { ...PROFILE, provider: "machine0" };
    const { provider, calls } = createWarmProvider(({ argv }) => {
      if (argv[2] === "create") {
        return commandResult({
          stdout: JSON.stringify({
            id: CHECKPOINT_ID,
            kind: "machine0-image",
            leaseId: LEASE_ID,
            native: { state: "ACTIVE" },
          }),
        });
      }
      if (argv[2] === "inspect") {
        return commandResult({
          stdout: JSON.stringify({
            localState: "metadata_available",
            providerState: "ACTIVE",
            nextAction: "fork_or_delete",
          }),
        });
      }
      return undefined;
    });
    await captureWarmImage(provider, profile);

    const create = calls.find(({ argv }) => argv[2] === "create");
    expect(create?.argv).toEqual([
      expect.any(String),
      "checkpoint",
      "create",
      "--provider",
      "machine0",
      "--id",
      LEASE_ID,
      "--mode",
      "native",
      "--wait",
      "--json",
      "--strategy",
      "image",
    ]);
    expect(create?.options.timeoutMs).toBe(600_000);
    const scrub = calls.find(({ options }) =>
      options.input?.toString().includes("CRABBOX_SCRUB_NODE_SCRIPT"),
    );
    expect(scrub?.options.timeoutMs).toBe(180_000);
    const teardownCalls = calls.slice(calls.indexOf(scrub!));
    // Include stop after capture: the caller must not time out while either still owns the lease.
    expect(provider.resolveDestroyTimeoutMs?.(profile)).toBeGreaterThanOrEqual(
      teardownCalls.reduce((total, call) => total + call.options.timeoutMs, 0),
    );
    calls.length = 0;
    await provisionWarmProfile(provider, profile, `provision:v2:${"2".repeat(64)}`);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
  });

  it.each([
    { action: "run", name: "scrub fails", result: { code: 7, stderr: "scrub failed" } },
    {
      action: "run",
      name: "scrub times out",
      result: { code: null, killed: true, termination: "timeout" as const },
    },
    { action: "create", name: "capture fails", result: { code: 7, stderr: "snapshot failed" } },
    {
      action: "create",
      name: "capture times out",
      result: { code: null, killed: true, termination: "timeout" as const },
    },
    {
      action: "create",
      name: "an older Crabbox rejects JSON output",
      result: { code: 2, stderr: "flag provided but not defined: -json" },
    },
    { action: "create", name: "capture returns malformed JSON", result: { stdout: "{" } },
  ])("warns once and still stops the enrolled lease when $name", async ({ action, result }) => {
    let tearingDown = false;
    const { provider, calls, warn } = createWarmProvider(({ argv }) => {
      if (tearingDown && (argv[1] === action || argv[2] === action)) {
        return commandResult(result);
      }
      return undefined;
    });
    const lease = await provisionWarmProfile(provider);
    tearingDown = true;

    await expect(
      provider.destroy({ leaseId: lease.leaseId, profile: PROFILE }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(calls.at(-1)?.argv[1]).toBe("stop");

    tearingDown = false;
    calls.length = 0;
    if (action === "create") {
      // Failed creation can retain a paid artifact; retry requires explicit cleanup acknowledgment.
      const capture = listCrabboxWarmImages()[0]?.capture;
      expect(capture).toBeDefined();
      recoverCrabboxWarmImageCapture(capture!.selector, true);
    }
    await captureWarmImage(provider);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
  });

  it("never captures a half-configured lease during failed provisioning cleanup", async () => {
    const { provider, calls } = createWarmProvider(({ argv, options }) =>
      argv[1] === "run" && options.input === "install-node"
        ? commandResult({ code: 7, stderr: "setup failed" })
        : undefined,
    );

    await expect(
      provisionWarmProfile(provider, { ...PROFILE, setup: "install-node" }),
    ).rejects.toThrow("Crabbox profile setup failed");

    expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
    expect(calls.at(-1)?.argv[1]).toBe("stop");
  });

  it.each(["aws", "hetzner"])(
    "rejects a requested warm image without a resolved class before %s commands",
    async (backend) => {
      const { provider, calls } = createWarmProvider();
      await expect(
        provisionWarmProfile(provider, {
          provider: backend,
          ttl: PROFILE.ttl,
          idleTimeout: PROFILE.idleTimeout,
          warmImage: true,
        }),
      ).rejects.toMatchObject({
        code: "invalid_profile",
        message: "Crabbox warmImage requires a configured class or a placement machine class",
      });
      expect(calls).toEqual([]);
    },
  );

  it.each(["standard", undefined])(
    "captures and restores placement overrides with configured class %s",
    async (machineClass) => {
      const { provider, calls } = createWarmProvider();
      const profile = { ...CLASSLESS_PROFILE, ...(machineClass ? { class: machineClass } : {}) };
      await captureWarmImage(provider, profile, OPERATION_ID, "fast");

      calls.length = 0;
      await provisionWarmProfile(provider, profile, `provision:v2:${"1".repeat(64)}`, "standard");
      expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
      expect(calls.some(({ argv }) => argv[2] === "fork")).toBe(false);

      const nextOperation = `provision:v2:${"2".repeat(64)}`;
      calls.length = 0;
      await provisionWarmProfile(provider, profile, nextOperation, "fast");
      const fork = calls.find(({ argv }) => argv[2] === "fork")?.argv;
      expect(fork?.[fork.indexOf("--lease-id") + 1]).toBe(operationLeaseId(nextOperation));
      expect(fork?.[fork.indexOf("--class") + 1]).toBe("fast");
    },
  );

  it.each([
    { machineClass: "standard", warmImage: true },
    { machineClass: undefined, warmImage: true },
    { machineClass: "standard", warmImage: undefined },
    { machineClass: undefined, warmImage: undefined },
  ])(
    "recovers the enrolled class after restart (configured=$machineClass, warmImage=$warmImage)",
    async ({ machineClass, warmImage }) => {
      const initial = createWarmProvider();
      const profile = {
        ...CLASSLESS_PROFILE,
        ...(warmImage === undefined ? {} : { warmImage }),
        ...(machineClass ? { class: machineClass } : {}),
      };
      const lease = await provisionWarmProfile(initial.provider, profile, OPERATION_ID, "fast");
      await initial.provider.dispose();

      const restarted = createWarmProvider(undefined, initial.stateDir);
      await restarted.provider.inspect({ leaseId: lease.leaseId, profile });
      await restarted.provider.destroy({ leaseId: lease.leaseId, profile });

      expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);

      restarted.calls.length = 0;
      await provisionWarmProfile(
        restarted.provider,
        profile,
        `provision:v2:${"1".repeat(64)}`,
        "standard",
      );
      expect(restarted.calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
      expect(restarted.calls.some(({ argv }) => argv[2] === "fork")).toBe(false);

      restarted.calls.length = 0;
      await provisionWarmProfile(
        restarted.provider,
        profile,
        `provision:v2:${"2".repeat(64)}`,
        "fast",
      );
      const fork = restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv;
      expect(fork?.[fork.indexOf("--class") + 1]).toBe("fast");
    },
  );

  it.each(["standard", undefined])(
    "never snapshots an inspection-only lease with configured class %s",
    async (machineClass) => {
      const { provider, calls } = createWarmProvider();
      const lease = {
        leaseId: LEASE_ID,
        profile: {
          ...CLASSLESS_PROFILE,
          warmImage: true,
          ...(machineClass ? { class: machineClass } : {}),
        },
      };

      await provider.inspect(lease);
      await provider.destroy(lease);

      expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
      expect(calls.at(-1)?.argv[1]).toBe("stop");
    },
  );

  it("forks an available image into the exact operation-owned lease before normal enrollment", async () => {
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider);
    calls.length = 0;

    await expect(provisionWarmProfile(provider)).resolves.toMatchObject({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
    });

    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv.slice(1)).toEqual([
      "checkpoint",
      "fork",
      CHECKPOINT_ID,
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
      operationSlug(OPERATION_ID),
      "--keep=true",
      "--json",
    ]);
    expect(calls.some(({ argv }) => argv[1] === "inspect")).toBe(true);
    expect(calls.some(({ argv, options }) => argv[1] === "run" && options.input)).toBe(true);
  });

  it.each([
    { name: "the fork fails", result: { code: 7, stderr: "snapshot unavailable" } },
    {
      name: "an older Crabbox rejects fixed lease IDs",
      result: { code: 2, stderr: "unknown flag: --lease-id" },
    },
    { name: "the fork returns malformed JSON", result: { stdout: "{" } },
  ])("does not change a checkpoint-bound lease to cold when $name", async ({ result }) => {
    const { provider, calls } = createWarmProvider(({ argv }) =>
      argv[2] === "fork" ? commandResult(result) : undefined,
    );
    await captureWarmImage(provider);
    calls.length = 0;

    await expect(provisionWarmProfile(provider)).rejects.toThrow();

    const fork = calls.find(({ argv }) => argv[2] === "fork")?.argv;
    const warmup = calls.find(({ argv }) => argv[1] === "warmup")?.argv;
    expect(fork?.[fork.indexOf("--lease-id") + 1]).toBe(LEASE_ID);
    expect(warmup).toBeUndefined();
    calls.length = 0;
    await expect(provisionWarmProfile(provider)).rejects.toThrow();
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
  });

  it.each([
    ["available", "fork_or_delete", "fork", true],
    ["available", "delete", "fork", true],
    ["Succeeded", "fork_or_delete", "fork", true],
    ["available", "fork_restore_or_delete", "fork", true],
    ["ACTIVE", "wait_or_delete", "warmup", true],
    ["ACTIVE", "check_runtime", "warmup", true],
    ["unverified_ref", "fork_or_delete_local", "warmup", true],
    ["missing", "delete_local", "warmup", false],
    [undefined, "delete_local", "warmup", false],
  ])(
    "verifies pending image state %s/action %s before %s",
    async (providerState, nextAction, expectedCommand, retained) => {
      const { provider, calls } = createWarmProvider(({ argv }) =>
        argv[2] === "inspect"
          ? commandResult({
              stdout: JSON.stringify({
                localState: "metadata_available",
                ...(providerState ? { providerState } : {}),
                nextAction,
              }),
            })
          : undefined,
      );
      await captureWarmImage(provider);
      calls.length = 0;

      const lease = await provisionWarmProfile(provider);

      expect(
        calls.some(({ argv }) => argv[1] === expectedCommand || argv[2] === expectedCommand),
      ).toBe(true);
      if (retained) {
        await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
        expect(calls.some(({ argv }) => argv[2] === "create")).toBe(false);
      } else {
        expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(true);
        await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
        expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
      }
    },
  );
});
