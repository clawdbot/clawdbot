// Install fallback tests cover alternate skill install paths when primary paths fail.
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { captureEnv } from "../../test-utils/env.js";
import { hasBinaryMock, runCommandWithTimeoutMock } from "../test-support/install-test-mocks.js";
import type { SkillEntry, SkillInstallSpec } from "../types.js";

const skillsMocks = vi.hoisted(() => ({
  loadWorkspaceSkillEntries: vi.fn(),
}));

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../../plugins/install-security-scan.js", () => ({
  evaluateSkillInstallPolicy: vi.fn(async () => undefined),
}));

vi.mock("../loading/workspace.js", () => ({
  loadWorkspaceSkillEntries: skillsMocks.loadWorkspaceSkillEntries,
}));

let installSkill: typeof import("./install.js").installSkill;
let resolveInstallerKindReadiness: typeof import("./install.js").resolveInstallerKindReadiness;
let skillsInstallTesting: typeof import("./install.test-support.js").skillsInstallTesting;

async function loadSkillsInstallModulesForTest() {
  ({ installSkill, resolveInstallerKindReadiness } = await import("./install.js"));
  ({ skillsInstallTesting } = await import("./install.test-support.js"));
}

function makeSkillEntry(
  workspaceDir: string,
  name: string,
  installSpec: SkillInstallSpec,
): SkillEntry {
  const skillDir = path.join(workspaceDir, "skills", name);
  return {
    skill: {
      name,
      description: "test skill",
      filePath: path.join(skillDir, "SKILL.md"),
      baseDir: skillDir,
      source: "openclaw-workspace",
    } as SkillEntry["skill"],
    frontmatter: {},
    metadata: {
      install: [{ id: "deps", ...installSpec }],
    },
  };
}

function mockAvailableBinaries(binaries: string[]) {
  const available = new Set(binaries);
  hasBinaryMock.mockImplementation((bin: string) => available.has(bin));
}

function assertNoAptGetFallbackCalls() {
  const aptCalls = runCommandWithTimeoutMock.mock.calls.filter((call) => {
    if (!Array.isArray(call[0])) {
      return false;
    }
    const argv = call[0] as string[];
    const isPermissionCheck =
      argv[0] === "sudo" && argv.some((arg) => arg === "-l" || arg === "-ll");
    return argv.includes("apt-get") && !isPermissionCheck;
  });
  expect(aptCalls).toHaveLength(0);
}

function mockPasswordlessSudoRule(): void {
  runCommandWithTimeoutMock.mockResolvedValueOnce({
    code: 0,
    stdout: "    Options: !authenticate\n",
    stderr: "",
  });
}

function commandCallAt(
  index: number,
): [
  string[],
  { env?: NodeJS.ProcessEnv | Record<string, string | undefined>; timeoutMs?: number },
] {
  const call =
    index < 0
      ? runCommandWithTimeoutMock.mock.calls[runCommandWithTimeoutMock.mock.calls.length + index]
      : runCommandWithTimeoutMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected command call ${index}`);
  }
  return call as [
    string[],
    { env?: NodeJS.ProcessEnv | Record<string, string | undefined>; timeoutMs?: number },
  ];
}

function expectAptPolicyCall(index: number): void {
  const [argv, options] = commandCallAt(index);
  expect(argv).toEqual(["apt-cache", "policy", "golang-go"]);
  expect(options.env).toEqual({ LC_ALL: "C" });
}

function expectLocalGoVersionEnvCall(index: number): void {
  const [argv, options] = commandCallAt(index);
  expect(argv).toEqual(["go", "env", "GOVERSION"]);
  expect(options.timeoutMs).toBe(5_000);
  expect(options.env).toEqual({ GOTOOLCHAIN: "local" });
}

function mockLocalGoVersion(version = "go1.22.4"): void {
  runCommandWithTimeoutMock.mockResolvedValueOnce({
    code: 0,
    stdout: version,
    stderr: "",
  });
}

function withUid<T>(uid: number, fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(process, "getuid").mockReturnValue(uid);
  return fn().finally(() => spy.mockRestore());
}

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-fallback-test-" });

describe("skills-install fallback edge cases", () => {
  let workspaceDir: string;
  let installEnvSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    workspaceDir = await suiteTempDirs.setup();
    skillsMocks.loadWorkspaceSkillEntries.mockReturnValue([
      makeSkillEntry(workspaceDir, "go-tool-single", {
        kind: "go",
        module: "example.com/tool@latest",
      }),
      makeSkillEntry(workspaceDir, "py-tool", {
        kind: "uv",
        package: "example-package",
      }),
    ]);
    await loadSkillsInstallModulesForTest();
  });

  beforeEach(() => {
    installEnvSnapshot = captureEnv(["PATH", "GOBIN", "GOPATH"]);
    runCommandWithTimeoutMock.mockReset();
    hasBinaryMock.mockReset();
    skillsInstallTesting.setDepsForTest({
      hasBinary: (bin: string) => hasBinaryMock(bin),
      resolveBrewExecutable: () => undefined,
      isContainerEnvironment: () => false,
    });
  });

  afterEach(() => {
    installEnvSnapshot.restore();
  });

  afterAll(async () => {
    skillsInstallTesting.setDepsForTest();
    await suiteTempDirs.cleanup();
  });

  it("handles sudo probe failures for go install without apt fallback", async () => {
    await withUid(1000, async () => {
      for (const testCase of [
        {
          label: "sudo returns password required",
          setup: () =>
            runCommandWithTimeoutMock.mockResolvedValueOnce({
              code: 1,
              stdout: "",
              stderr: "sudo: a password is required",
            }),
          assert: (result: { message: string; stderr: string }) => {
            expect(result.message).toContain("sudo is not usable");
            expect(result.message).toContain("https://go.dev/doc/install");
            expect(result.stderr).toContain("sudo: a password is required");
          },
        },
        {
          label: "sudo probe throws executable-not-found",
          setup: () =>
            runCommandWithTimeoutMock.mockRejectedValueOnce(
              new Error('Executable not found in $PATH: "sudo"'),
            ),
          assert: (result: { message: string; stderr: string }) => {
            expect(result.message).toContain("sudo is not usable");
            expect(result.message).toContain("https://go.dev/doc/install");
            expect(result.stderr).toContain("Executable not found");
          },
        },
      ]) {
        runCommandWithTimeoutMock.mockClear();
        mockAvailableBinaries(["apt-get", "sudo"]);
        testCase.setup();

        const result = await installSkill({
          workspaceDir,
          skillName: "go-tool-single",
          installId: "deps",
        });

        expect(result.ok, testCase.label).toBe(false);
        testCase.assert(result);
        const sudoCall = commandCallAt(0);
        expect(sudoCall?.[0], testCase.label).toEqual([
          "sudo",
          "-k",
          "-n",
          "-ll",
          "apt-get",
          "update",
          "-qq",
        ]);
        expect(sudoCall?.[1]?.timeoutMs, testCase.label).toBe(5_000);
        expect(sudoCall?.[1]?.env, testCase.label).toEqual({ LC_ALL: "C" });
        assertNoAptGetFallbackCalls();
      }
    });
  });

  it("rejects an apt rule that requires authentication even when sudo listing succeeds", async () => {
    await withUid(1000, async () => {
      mockAvailableBinaries(["apt-get", "sudo"]);
      mockPasswordlessSudoRule();
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "    Options: authenticate\n",
        stderr: "",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "go-tool-single",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(commandCallAt(0)[0]).toEqual(["sudo", "-k", "-n", "-ll", "apt-get", "update", "-qq"]);
      expect(commandCallAt(1)[0]).toEqual([
        "sudo",
        "-k",
        "-n",
        "-ll",
        "apt-get",
        "install",
        "-y",
        "golang-go",
      ]);
      assertNoAptGetFallbackCalls();
    });
  });

  it("uv not installed and no brew returns helpful error without curl auto-install", async () => {
    mockAvailableBinaries(["curl"]);

    const result = await installSkill({
      workspaceDir,
      skillName: "py-tool",
      installId: "deps",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("https://docs.astral.sh/uv/getting-started/installation/");

    // Verify NO curl command was attempted (no auto-install)
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("returns container-specific guidance when brew is missing in a Linux container", async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    skillsInstallTesting.setDepsForTest({
      hasBinary: (bin: string) => hasBinaryMock(bin),
      resolveBrewExecutable: () => undefined,
      isContainerEnvironment: () => true,
    });
    mockAvailableBinaries([]);
    try {
      skillsMocks.loadWorkspaceSkillEntries.mockReturnValueOnce([
        makeSkillEntry(workspaceDir, "brew-tool-container", {
          kind: "brew",
          formula: "openai-whisper",
        }),
      ]);

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool-container",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Linux container");
      expect(result.message).toContain("Build a custom image");
      expect(result.message).toContain("openai-whisper");
      expect(result.message).not.toContain("https://brew.sh");
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("does not use HOMEBREW_PREFIX as a brew bin fallback for go installs", async () => {
    const envSnapshot = captureEnv(["HOMEBREW_PREFIX"]);
    try {
      const maliciousPrefix = path.join(workspaceDir, "evil-brew");
      process.env.HOMEBREW_PREFIX = maliciousPrefix;
      mockAvailableBinaries([]);
      skillsInstallTesting.setDepsForTest({
        hasBinary: (bin: string) => hasBinaryMock(bin),
        resolveBrewExecutable: () => "/safe/homebrew/bin/brew",
      });
      runCommandWithTimeoutMock.mockResolvedValue({
        code: 0,
        stdout: "ok",
        stderr: "",
        signal: null,
        killed: false,
      });
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "installed go",
        stderr: "",
        signal: null,
        killed: false,
      });
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "prefix unavailable",
        signal: null,
        killed: false,
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "go-tool-single",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      const brewInstallCall = commandCallAt(0);
      expect(brewInstallCall?.[0]).toEqual(["/safe/homebrew/bin/brew", "install", "go"]);
      expect(brewInstallCall?.[1]?.timeoutMs).toBe(300_000);
      const brewPrefixCall = commandCallAt(1);
      expect(brewPrefixCall[0]).toEqual(["/safe/homebrew/bin/brew", "--prefix"]);
      expect(brewPrefixCall[1].timeoutMs).toBe(30_000);
      const finalCall = commandCallAt(-1);
      expect(finalCall?.[0]).toEqual(["go", "install", "example.com/tool@latest"]);
      expect(finalCall?.[1]?.env?.GOBIN).not.toBe(path.join(maliciousPrefix, "bin"));
    } finally {
      envSnapshot.restore();
    }
  });

  it("routes existing Go installs to the restart-stable user bin without changing Go config", async () => {
    process.env.PATH = "/usr/bin";
    process.env.GOBIN = "/operator/go/bin";
    process.env.GOPATH = "/operator/go";
    mockAvailableBinaries(["go", "brew"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool-single",
      installId: "deps",
    });

    expect(result.ok).toBe(true);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    const installCall = commandCallAt(0);
    expect(installCall[0]).toEqual(["go", "install", "example.com/tool@latest"]);
    const localBin = path.join(os.homedir(), ".local", "bin");
    expect(installCall[1].env).toMatchObject({
      GOBIN: localBin,
      PATH: ["/usr/bin", localBin].join(path.delimiter),
    });
    expect(process.env.PATH).toBe(["/usr/bin", localBin].join(path.delimiter));
    expect(process.env.GOBIN).toBe("/operator/go/bin");
    expect(process.env.GOPATH).toBe("/operator/go");
  });

  describe("resolveInstallerKindReadiness", () => {
    it("keeps missing-Go recipes ready when passwordless sudo can run apt-get", async () => {
      await withUid(1000, async () => {
        mockAvailableBinaries(["apt-get", "sudo"]);
        mockPasswordlessSudoRule();
        mockPasswordlessSudoRule();

        expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: true });
        expect(commandCallAt(0)[0]).toEqual([
          "sudo",
          "-k",
          "-n",
          "-ll",
          "apt-get",
          "update",
          "-qq",
        ]);
        expect(commandCallAt(1)[0]).toEqual([
          "sudo",
          "-k",
          "-n",
          "-ll",
          "apt-get",
          "install",
          "-y",
          "golang-go",
        ]);
        expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(2);
      });
    });

    it("defers apt candidate validation until the policy-approved refresh", async () => {
      await withUid(0, async () => {
        mockAvailableBinaries(["apt-get"]);

        expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: true });
        expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
      });
    });

    it("skips missing-Go recipes when neither brew nor a usable apt path exists", async () => {
      await withUid(1000, async () => {
        // apt-get exists but there is no root, sudo, or brew to run it with.
        mockAvailableBinaries(["apt-get"]);

        expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: false, reason: "go" });
        expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
      });
    });

    it("uses off-PATH Linuxbrew for Go but not uv bootstraps", async () => {
      mockAvailableBinaries([]);
      skillsInstallTesting.setDepsForTest({
        hasBinary: (bin: string) => hasBinaryMock(bin),
        resolveBrewExecutable: () => "/home/linuxbrew/.linuxbrew/bin/brew",
        isContainerEnvironment: () => false,
      });
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "/home/linuxbrew/.linuxbrew\n",
        stderr: "",
      });

      expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: true });
      expect(await resolveInstallerKindReadiness("uv")).toEqual({ ready: false, reason: "uv" });
      expect(await resolveInstallerKindReadiness("brew")).toEqual({ ready: true });
      expect(commandCallAt(0)[0]).toEqual(["/home/linuxbrew/.linuxbrew/bin/brew", "--prefix"]);
    });

    it("lets the selected Homebrew install determine directory writability", async () => {
      mockAvailableBinaries(["brew"]);
      runCommandWithTimeoutMock.mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: "directories are not writable",
      });

      expect(await resolveInstallerKindReadiness("brew")).toEqual({ ready: true });
      expect(await resolveInstallerKindReadiness("uv")).toEqual({ ready: true });
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });

    it("keeps usable Go ready without consulting an unrelated Homebrew install", async () => {
      mockAvailableBinaries(["go", "brew"]);
      mockLocalGoVersion("go1.24.12");

      expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: true });
      expectLocalGoVersionEnvCall(0);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    });

    it("skips too-old Go even though the binary exists", async () => {
      mockAvailableBinaries(["go", "brew"]);
      mockLocalGoVersion("go1.18.1");

      expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: false, reason: "go" });
      expectLocalGoVersionEnvCall(0);
    });

    it("keeps usable Go ready without consulting brew or apt", async () => {
      mockAvailableBinaries(["go"]);
      mockLocalGoVersion();

      expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: true });
      expectLocalGoVersionEnvCall(0);
    });

    it.each(["local", "path", "go1.22.4", "asdf+auto"])(
      "keeps a supported local compiler ready with GOTOOLCHAIN=%s",
      async (toolchain) => {
        const envSnapshot = captureEnv(["GOTOOLCHAIN"]);
        try {
          process.env.GOTOOLCHAIN = toolchain;
          mockAvailableBinaries(["go"]);
          mockLocalGoVersion();

          expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: true });
          expectLocalGoVersionEnvCall(0);
        } finally {
          envSnapshot.restore();
        }
      },
    );

    it("mirrors uv and brew fallbacks and passes unknown kinds through", async () => {
      mockAvailableBinaries([]);
      expect(await resolveInstallerKindReadiness("uv")).toEqual({ ready: false, reason: "uv" });
      expect(await resolveInstallerKindReadiness("brew")).toEqual({ ready: false, reason: "brew" });
      expect(await resolveInstallerKindReadiness("node")).toEqual({ ready: true });

      // On-PATH brew satisfies brew recipes and uv's brew bootstrap.
      mockAvailableBinaries(["brew"]);
      runCommandWithTimeoutMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      expect(await resolveInstallerKindReadiness("uv")).toEqual({ ready: true });
      expect(await resolveInstallerKindReadiness("brew")).toEqual({ ready: true });
    });
  });

  it("refreshes apt metadata before installing an accepted Go candidate", async () => {
    await withUid(0, async () => {
      mockAvailableBinaries(["apt-get"]);
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "golang-go:\n  Installed: (none)\n  Candidate: 2:1.22.1-1ubuntu1\n",
        stderr: "",
      });
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await installSkill({
        workspaceDir,
        skillName: "go-tool-single",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(commandCallAt(0)[0]).toEqual(["apt-get", "update", "-qq"]);
      expectAptPolicyCall(1);
      expect(commandCallAt(2)[0]).toEqual(["apt-get", "install", "-y", "golang-go"]);
      expect(commandCallAt(3)[0]).toEqual(["go", "install", "example.com/tool@latest"]);
    });
  });

  it("keeps sudo apt probes and execution noninteractive", async () => {
    await withUid(1000, async () => {
      mockAvailableBinaries(["apt-get", "sudo"]);
      mockPasswordlessSudoRule();
      mockPasswordlessSudoRule();
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "golang-go:\n  Installed: (none)\n  Candidate: 2:1.22.1-1ubuntu1\n",
        stderr: "",
      });
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await installSkill({
        workspaceDir,
        skillName: "go-tool-single",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock.mock.calls.map((call) => call[0])).toEqual([
        ["sudo", "-k", "-n", "-ll", "apt-get", "update", "-qq"],
        ["sudo", "-k", "-n", "-ll", "apt-get", "install", "-y", "golang-go"],
        ["sudo", "-n", "apt-get", "update", "-qq"],
        ["apt-cache", "policy", "golang-go"],
        ["sudo", "-n", "apt-get", "install", "-y", "golang-go"],
        ["go", "install", "example.com/tool@latest"],
      ]);
    });
  });

  it("uses the current supported apt candidate when metadata refresh fails", async () => {
    await withUid(0, async () => {
      mockAvailableBinaries(["apt-get"]);
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "temporary repository failure",
      });
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "golang-go:\n  Installed: (none)\n  Candidate: 2:1.22.1-1ubuntu1\n",
        stderr: "",
      });
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await installSkill({
        workspaceDir,
        skillName: "go-tool-single",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(commandCallAt(0)[0]).toEqual(["apt-get", "update", "-qq"]);
      expectAptPolicyCall(1);
      expect(commandCallAt(2)[0]).toEqual(["apt-get", "install", "-y", "golang-go"]);
      expect(commandCallAt(3)[0]).toEqual(["go", "install", "example.com/tool@latest"]);
    });
  });

  it("rejects the current old apt candidate when metadata refresh fails", async () => {
    await withUid(0, async () => {
      mockAvailableBinaries(["apt-get"]);
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "temporary repository failure",
      });
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "golang-go:\n  Installed: (none)\n  Candidate: 2:1.19~1\n",
        stderr: "",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "go-tool-single",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.skipReason).toBe("go");
      expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(2);
      expectAptPolicyCall(1);
    });
  });

  it("does not install an old apt Go candidate after refreshing empty metadata", async () => {
    await withUid(0, async () => {
      mockAvailableBinaries(["apt-get"]);
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "golang-go:\n  Installed: (none)\n  Candidate: 2:1.19~1\n",
        stderr: "",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "go-tool-single",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("usable Go 1.21+ package");
      expect(result.skipReason).toBe("go");
      expect(runCommandWithTimeoutMock.mock.calls.map((call) => call[0])).toEqual([
        ["apt-get", "update", "-qq"],
        ["apt-cache", "policy", "golang-go"],
      ]);
      expectAptPolicyCall(1);
    });
  });

  it.each([
    [
      "a newer module Go requirement",
      "go: example.com/tool@latest requires go >= 1.24 (running go 1.22; GOTOOLCHAIN=local)",
    ],
    ["an invalid toolchain setting", 'go: invalid GOTOOLCHAIN "asdf+auto"'],
    ["a missing PATH toolchain", 'go: cannot find "go1.24.0" in PATH'],
  ])("classifies %s as a deferred Go prerequisite", async (_label, stderr) => {
    mockAvailableBinaries(["go"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr,
    });

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool-single",
      installId: "deps",
    });

    expect(result.ok).toBe(false);
    expect(result.skipReason).toBe("go");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(commandCallAt(0)[0]).toEqual(["go", "install", "example.com/tool@latest"]);
  });

  it("keeps ordinary Go install failures as install failures", async () => {
    process.env.PATH = "/usr/bin";
    mockAvailableBinaries(["go"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "go: example.com/tool@latest: module not found",
    });

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool-single",
      installId: "deps",
    });

    expect(result.ok).toBe(false);
    expect(result.skipReason).toBeUndefined();
    expect(process.env.PATH).toBe("/usr/bin");
  });

  it("does not override a configured fixed toolchain for direct Go installs", async () => {
    const envSnapshot = captureEnv(["GOTOOLCHAIN"]);
    try {
      process.env.GOTOOLCHAIN = "local";
      process.env.PATH = "/usr/bin";
      process.env.GOBIN = "/operator/go/bin";
      process.env.GOPATH = "/operator/go";
      mockAvailableBinaries(["go"]);
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "installed",
        stderr: "",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "go-tool-single",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
      const [argv, options] = commandCallAt(0);
      expect(argv).toEqual(["go", "install", "example.com/tool@latest"]);
      const localBin = path.join(os.homedir(), ".local", "bin");
      expect(options.env).toEqual({
        GOBIN: localBin,
        PATH: ["/usr/bin", localBin].join(path.delimiter),
      });
      expect(options.env).not.toHaveProperty("GOTOOLCHAIN");
      expect(process.env.GOBIN).toBe("/operator/go/bin");
      expect(process.env.GOPATH).toBe("/operator/go");
    } finally {
      envSnapshot.restore();
    }
  });

  it("preserves system uv/python env vars when running uv installs", async () => {
    mockAvailableBinaries(["uv"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });

    const envSnapshot = captureEnv([
      "UV_PYTHON",
      "UV_INDEX_URL",
      "PIP_INDEX_URL",
      "PYTHONPATH",
      "VIRTUAL_ENV",
    ]);
    try {
      process.env.UV_PYTHON = "/tmp/attacker-python";
      process.env.UV_INDEX_URL = "https://example.invalid/simple";
      process.env.PIP_INDEX_URL = "https://example.invalid/pip";
      process.env.PYTHONPATH = "/tmp/attacker-pythonpath";
      process.env.VIRTUAL_ENV = "/tmp/attacker-venv";

      const result = await installSkill({
        workspaceDir,
        skillName: "py-tool",
        installId: "deps",
        timeoutMs: 10_000,
      });

      expect(result.ok).toBe(true);
      const firstCall = commandCallAt(0);
      expect(firstCall?.[0]).toEqual(["uv", "tool", "install", "example-package"]);
      expect(firstCall?.[1]?.timeoutMs).toBe(10_000);
      const envArg = firstCall?.[1]?.env;
      expect(envArg).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });
});
