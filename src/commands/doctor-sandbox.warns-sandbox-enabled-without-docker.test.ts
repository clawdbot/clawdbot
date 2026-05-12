import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

const runExec = vi.fn();
const note = vi.fn();
const inspectLegacySandboxRegistryFiles = vi.fn();
const migrateLegacySandboxRegistryFiles = vi.fn();

vi.mock("../process/exec.js", () => ({
  runExec,
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => ({
  DEFAULT_SANDBOX_BROWSER_IMAGE: "browser-image",
  DEFAULT_SANDBOX_COMMON_IMAGE: "common-image",
  DEFAULT_SANDBOX_IMAGE: "default-image",
  resolveSandboxScope: vi.fn(() => "shared"),
}));

vi.mock("../agents/sandbox/registry.js", () => ({
  inspectLegacySandboxRegistryFiles,
  migrateLegacySandboxRegistryFiles,
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

const { maybeRepairSandboxImages, maybeRepairSandboxRegistryFiles } =
  await import("./doctor-sandbox.js");

describe("maybeRepairSandboxImages", () => {
  const mockRuntime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  const mockPrompter: DoctorPrompter = {
    confirmRuntimeRepair: vi.fn().mockResolvedValue(false),
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    } satisfies DoctorRepairMode,
  } as unknown as DoctorPrompter;

  beforeEach(() => {
    vi.clearAllMocks();
    inspectLegacySandboxRegistryFiles.mockResolvedValue([]);
    migrateLegacySandboxRegistryFiles.mockResolvedValue([]);
  });

  function createSandboxConfig(mode: "off" | "all" | "non-main"): OpenClawConfig {
    return {
      agents: {
        defaults: {
          sandbox: {
            mode,
          },
        },
      },
    };
  }

  async function runSandboxRepair(params: {
    mode: "off" | "all" | "non-main";
    dockerAvailable: boolean;
  }) {
    if (params.dockerAvailable) {
      runExec.mockResolvedValue({ stdout: "24.0.0", stderr: "" });
    } else {
      runExec.mockRejectedValue(new Error("Docker not installed"));
    }
    await maybeRepairSandboxImages(createSandboxConfig(params.mode), mockRuntime, mockPrompter);
  }

  it("warns when sandbox mode is enabled but Docker is not available", async () => {
    await runSandboxRepair({ mode: "non-main", dockerAvailable: false });

    // The warning should clearly indicate sandbox is enabled but won't work
    expect(note).toHaveBeenCalled();
    const noteCall = note.mock.calls.at(0);
    if (noteCall === undefined) {
      throw new Error("expected sandbox warning note");
    }
    const message = noteCall[0] as string;

    // The message should warn that sandbox mode won't function, not just "skipping checks"
    expect(message).toMatch(/sandbox.*mode.*enabled|sandbox.*won.*work|docker.*required/i);
    // Should NOT just say "skipping sandbox image checks" - that's too mild
    expect(message).not.toBe("Docker not available; skipping sandbox image checks.");
  });

  it("warns when sandbox mode is 'all' but Docker is not available", async () => {
    await runSandboxRepair({ mode: "all", dockerAvailable: false });

    expect(note).toHaveBeenCalled();
    const noteCall = note.mock.calls.at(0);
    if (noteCall === undefined) {
      throw new Error("expected sandbox warning note");
    }
    const message = noteCall[0] as string;

    // Should warn about the impact on sandbox functionality
    expect(message).toMatch(/sandbox|docker/i);
  });

  it("does not warn when sandbox mode is off", async () => {
    await runSandboxRepair({ mode: "off", dockerAvailable: false });

    // No warning needed when sandbox is off
    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when Docker is available", async () => {
    await runSandboxRepair({ mode: "non-main", dockerAvailable: true });

    // May have other notes about images, but not the Docker unavailable warning
    const dockerUnavailableWarning = note.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].toLowerCase().includes("docker not available"),
    );
    expect(dockerUnavailableWarning).toBeUndefined();
  });
});

describe("maybeRepairSandboxRegistryFiles", () => {
  const mockPrompter = {
    shouldRepair: false,
  } as DoctorPrompter;

  beforeEach(() => {
    vi.clearAllMocks();
    inspectLegacySandboxRegistryFiles.mockResolvedValue([]);
    migrateLegacySandboxRegistryFiles.mockResolvedValue([]);
  });

  it("warns about legacy registry files without migrating outside doctor --fix", async () => {
    inspectLegacySandboxRegistryFiles.mockResolvedValue([
      {
        kind: "containers",
        registryPath: "/tmp/openclaw/sandbox/containers.json",
        shardedDir: "/tmp/openclaw/sandbox/containers",
        exists: true,
        valid: true,
        entries: 2,
      },
    ]);

    await maybeRepairSandboxRegistryFiles(mockPrompter);

    expect(migrateLegacySandboxRegistryFiles).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      [
        "Legacy sandbox registry files detected.",
        "- containers: /tmp/openclaw/sandbox/containers.json (2 entries)",
        "Run openclaw doctor --fix to migrate them to sharded registry files.",
      ].join("\n"),
      "Sandbox",
    );
  });

  it("migrates legacy registry files during doctor --fix", async () => {
    inspectLegacySandboxRegistryFiles.mockResolvedValue([
      {
        kind: "containers",
        registryPath: "/tmp/openclaw/sandbox/containers.json",
        shardedDir: "/tmp/openclaw/sandbox/containers",
        exists: true,
        valid: true,
        entries: 2,
      },
    ]);
    migrateLegacySandboxRegistryFiles.mockResolvedValue([
      {
        kind: "containers",
        registryPath: "/tmp/openclaw/sandbox/containers.json",
        shardedDir: "/tmp/openclaw/sandbox/containers",
        status: "migrated",
        entries: 2,
      },
    ]);

    await maybeRepairSandboxRegistryFiles({
      ...mockPrompter,
      shouldRepair: true,
    } as DoctorPrompter);

    expect(migrateLegacySandboxRegistryFiles).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(
      "- Migrated containers registry from /tmp/openclaw/sandbox/containers.json into 2 shards.",
      "Doctor changes",
    );
  });
});
