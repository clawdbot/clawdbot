import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  root: "",
  phase: "initializing",
  mounted: true,
  nested: false,
  wrongBacking: false,
  unmountFails: false,
  calls: [] as string[],
  removed: false,
  outputAllocated: false,
  candidateCreated: false,
  helperMissing: false,
  readyConfigurations: false,
  networkCommand: "slirp4netns",
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    appendFileSync: () => {},
    writeFileSync: () => {},
    truncateSync: () => {},
    mkdirSync: () => {
      fixture.outputAllocated = true;
    },
    chmodSync: () => {},
    mkdtempSync: () => path.join(fixture.root, "scratch"),
    realpathSync: (value: string) => value,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o600 }),
    statSync: () => ({ size: 32 * 1024 ** 3, uid: 1000, mode: 0o600, isSocket: () => true }),
    readFileSync: (file: string) => {
      fixture.calls.push(`read:${file}`);
      if (fixture.readyConfigurations && file.endsWith("storage.conf")) {
        const mount = path.join(fixture.root, "volume");
        return `[storage]\ndriver = "overlay"\nrunroot = "${mount}/runroot"\ngraphroot = "${mount}/graphroot"\n`;
      }
      if (fixture.readyConfigurations && file.endsWith("containers.conf")) {
        return '[containers]\nlog_driver = "k8s-file"\nlog_size_max = 1048576\n[network]\ndefault_rootless_network_cmd = "slirp4netns"\n';
      }
      if (!file.endsWith("manifest.json")) {
        throw new Error("Configuration is not initialized");
      }
      return JSON.stringify({
        schema: "mantis.podman-storage.v1",
        root: fixture.root,
        uid: 1000,
        gid: 1000,
        bytes: 32 * 1024 ** 3,
        phase: fixture.phase,
      });
    },
    rmSync: () => {
      fixture.removed = true;
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const child = await original<typeof import("node:child_process")>();
  return {
    ...child,
    spawnSync: () => ({ status: fixture.mounted ? 0 : 1 }),
    execFileSync: (name: string, args: string[]) => {
      fixture.calls.push(`${name} ${args.join(" ")}`);
      if (name === "slirp4netns") {
        if (fixture.helperMissing) {
          throw new Error("Required networking helper unavailable");
        }
        return "slirp4netns version 1.3.3";
      }
      if (name === "podman" && args[0] === "info") {
        const mount = path.join(fixture.root, "volume");
        return JSON.stringify({
          host: {
            security: { rootless: true },
            logDriver: "k8s-file",
            rootlessNetworkCmd: fixture.networkCommand,
          },
          store: { graphRoot: `${mount}/graphroot`, runRoot: `${mount}/runroot` },
        });
      }
      if (name === "fallocate") {
        throw new Error("Allocation failed: no space left");
      }
      if (name === "mkfs.ext4") {
        return "";
      }
      if (name === "sudo" && args[0] === "mount") {
        throw new Error("Mount reached without backing reservation");
      }
      if (name === "git" && args[0] === "diff") {
        return "";
      }
      if (name === "podman" && args[0] === "create") {
        fixture.candidateCreated = true;
        throw new Error("Candidate creation reached without verified storage");
      }
      if (name === "podman" && args[0] === "rm") {
        return "";
      }
      const mount = path.join(fixture.root, "volume");
      if (name === "sudo" && args[0] === "losetup") {
        return JSON.stringify({
          loopdevices: [
            {
              name: "/dev/loop7",
              "back-file": fixture.wrongBacking
                ? "/unrelated.img"
                : path.join(fixture.root, "storage.img"),
            },
          ],
        });
      }
      if (name === "findmnt" && args.includes("--mountpoint")) {
        return JSON.stringify({
          filesystems: [{ target: mount, source: "/dev/loop7", fstype: "ext4" }],
        });
      }
      if (name === "findmnt" && args.includes("--list")) {
        return JSON.stringify({
          filesystems: [
            { target: mount },
            ...(fixture.nested ? [{ target: path.join(mount, "nested") }] : []),
          ],
        });
      }
      if (name === "sudo" && args[0] === "umount") {
        if (fixture.unmountFails) {
          throw new Error("Mount has live holders");
        }
        fixture.mounted = false;
        return "";
      }
      if (name === "findmnt" && args.includes("--target")) {
        return JSON.stringify({ filesystems: [{ target: "/" }] });
      }
      throw new Error(`Unexpected cleanup command: ${name}`);
    },
  };
});
const originalArgv = process.argv;
const cleanupPath = fileURLToPath(
  new URL("../../scripts/mantis/telegram-proof-storage.mts", import.meta.url),
);
const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
const gidDescriptor = Object.getOwnPropertyDescriptor(process, "getgid");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetModules();
  process.argv = [process.execPath, cleanupPath, "cleanup"];
  fixture.root = path.resolve("mantis-podman-fixture");
  Object.assign(fixture, {
    phase: "initializing",
    mounted: true,
    nested: false,
    wrongBacking: false,
    unmountFails: false,
    calls: [],
    removed: false,
    outputAllocated: false,
    candidateCreated: false,
    helperMissing: false,
    readyConfigurations: false,
    networkCommand: "slirp4netns",
  });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  Object.defineProperty(process, "getgid", { configurable: true, value: () => 1000 });
  vi.stubEnv("MANTIS_PODMAN_ROOT", fixture.root);
});
afterEach(() => {
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", platformDescriptor);
  if (uidDescriptor) {
    Object.defineProperty(process, "getuid", uidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
  if (gidDescriptor) {
    Object.defineProperty(process, "getgid", gidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getgid");
  }
  vi.unstubAllEnvs();
});
describe("interrupted mounted storage initialization", () => {
  it("refuses setup before allocation when the networking helper is unavailable", async () => {
    fixture.helperMissing = true;
    process.argv = [process.execPath, cleanupPath, "setup"];
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    await expect(import("../../scripts/mantis/telegram-proof-storage.mts")).rejects.toThrow(
      "Required networking helper unavailable",
    );
    expect(fixture.calls.some((call) => call.startsWith("fallocate "))).toBe(false);
    expect(fixture.candidateCreated).toBe(false);
  });
  it.each(["slirp4netns", "pasta"])(
    "verifies the actual rootless networking helper (%s)",
    async (networkCommand) => {
      fixture.phase = "ready";
      fixture.readyConfigurations = true;
      fixture.networkCommand = networkCommand;
      process.argv = [process.execPath, "fixture"];
      const storage = await import("../../scripts/mantis/telegram-proof-storage.mts");
      for (const [key, value] of Object.entries(storage.proofStorageEnvironment())) {
        vi.stubEnv(key, value);
      }
      if (networkCommand === "slirp4netns") {
        expect(() => storage.assertPodmanProofStorage()).not.toThrow();
      } else {
        expect(() => storage.assertPodmanProofStorage()).toThrow(
          "Podman escaped bounded rootless storage",
        );
      }
    },
  );
  it("refuses mounting when backing allocation fails", async () => {
    process.argv = [process.execPath, cleanupPath, "setup"];
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    vi.stubEnv("RUNNER_TEMP", fixture.root);
    vi.stubEnv("GITHUB_ENV", path.join(fixture.root, "github-env"));
    await expect(import("../../scripts/mantis/telegram-proof-storage.mts")).rejects.toThrow(
      "Allocation failed: no space left",
    );
    expect(fixture.calls.some((call) => call.startsWith("sudo mount "))).toBe(false);
    expect(fixture.candidateCreated).toBe(false);
  });
  it("refuses Web candidate creation before bounded storage is ready", async () => {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("../../scripts/mantis/run-request-web-ui.mts", import.meta.url)),
      "a".repeat(40),
      path.join(fixture.root, "web-output"),
    ];
    await expect(import("../../scripts/mantis/run-request-web-ui.mts")).rejects.toThrow(
      "Proof storage initialization is incomplete",
    );
    expect(fixture.outputAllocated).toBe(false);
    expect(fixture.candidateCreated).toBe(false);
  });
  it("unmounts verified initialization without requiring absent configs or user bus", async () => {
    await import("../../scripts/mantis/telegram-proof-storage.mts");
    expect(fixture.removed).toBe(true);
    expect(fixture.calls).toContain(`sudo umount ${path.join(fixture.root, "volume")}`);
  });
  it.each(["nested", "wrongBacking", "unmountFails"] as const)(
    "retains storage on %s",
    async (failure) => {
      fixture[failure] = true;
      await expect(import("../../scripts/mantis/telegram-proof-storage.mts")).rejects.toThrow();
      expect(fixture.removed).toBe(false);
    },
  );
  it("keeps ready cleanup strict when configurations disappear", async () => {
    fixture.phase = "ready";
    await expect(import("../../scripts/mantis/telegram-proof-storage.mts")).rejects.toThrow(
      "Configuration is not initialized",
    );
    expect(fixture.removed).toBe(false);
    expect(fixture.calls.some((call) => call.startsWith("sudo umount"))).toBe(false);
  });
});
