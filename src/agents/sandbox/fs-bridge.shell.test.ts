import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSandbox,
  createSandboxFsBridge,
  createSeededSandboxFsBridge,
  getScriptsFromCalls,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  mockedOpenRootFile,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

function expectNoScriptsContaining(scripts: string[], needle: string) {
  expect(scripts.some((script) => script.includes(needle))).toBe(false);
}

function expectSomeScriptContaining(scripts: string[], needle: string) {
  expect(scripts.some((script) => script.includes(needle))).toBe(true);
}

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

describe("sandbox fs bridge shell compatibility", () => {
  installFsBridgeTestHarness();

  it("uses POSIX-safe shell prologue in all bridge commands", async () => {
    await withTempDir("openclaw-fs-bridge-shell-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "a.txt"), "hello");
      await fs.writeFile(path.join(workspaceDir, "b.txt"), "bye");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await bridge.readFile({ filePath: "a.txt" });
      await bridge.writeFile({ filePath: "b.txt", data: "hello" });
      await bridge.mkdirp({ filePath: "nested" });
      await bridge.remove({ filePath: "b.txt" });
      await bridge.rename({ from: "a.txt", to: "c.txt" });
      await bridge.stat({ filePath: "c.txt" });

      expect(mockedExecDockerRaw).toHaveBeenCalledTimes(19);

      const scripts = getScriptsFromCalls();
      const executables = mockedExecDockerRaw.mock.calls.map(([args]) => args[3] ?? "");

      expect(executables.every((shell) => shell === "sh")).toBe(true);
      expect(scripts.every((script) => /set -eu[;\n]/.test(script))).toBe(true);
      expectNoScriptsContaining(scripts, "pipefail");
    });
  });

  it("path canonicalization recheck script is valid POSIX sh", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.writeFile({ filePath: "b.txt", data: "hello" });

    const scripts = getScriptsFromCalls();
    const canonicalScript = scripts.find((script) => script.includes("allow_final"));
    expect(canonicalScript).toContain("allow_final");
    expect(canonicalScript).not.toMatch(/\bdo;/);
    expect(canonicalScript).toMatch(/\bdo\n\s*parent=/);
  });

  it("reads inbound media-style filenames with triple-dash ids", async () => {
    await withTempDir("openclaw-fs-bridge-read-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const inboundPath = "media/inbound/file_1095---f00a04a2-99a0-4d98-99b0-dfe61c5a4198.ogg";
      await fs.mkdir(path.join(workspaceDir, "media", "inbound"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, inboundPath), "voice");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.readFile({ filePath: inboundPath })).resolves.toEqual(
        Buffer.from("voice"),
      );
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("resolves dash-leading basenames into absolute container paths", async () => {
    await withTempDir("openclaw-fs-bridge-read-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "--leading.txt"), "dash");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.readFile({ filePath: "--leading.txt" })).resolves.toEqual(
        Buffer.from("dash"),
      );
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("resolves bind-mounted absolute container paths for reads", async () => {
    await withTempDir("openclaw-fs-bridge-bind-read-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const bindRoot = path.join(stateDir, "workspace-two");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(bindRoot, { recursive: true });
      await fs.writeFile(path.join(bindRoot, "README.md"), "bind-read");

      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        docker: {
          ...createSandbox().docker,
          binds: [`${bindRoot}:/workspace-two:ro`],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });

      await expect(bridge.readFile({ filePath: "/workspace-two/README.md" })).resolves.toEqual(
        Buffer.from("bind-read"),
      );
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("writes via temp file + atomic rename (never direct truncation)", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.writeFile({ filePath: "b.txt", data: "hello" });

    const scripts = getScriptsFromCalls();
    expectNoScriptsContaining(scripts, "python3 - \"$@\" <<'PY'");
    expectSomeScriptContaining(scripts, 'exec "$python_cmd" -c "$python_script" "$@"');
    expectNoScriptsContaining(scripts, 'cat >"$1"');
    expectNoScriptsContaining(scripts, 'cat >"$tmp"');
    expectSomeScriptContaining(scripts, "os.replace(");
  });

  it("routes mkdirp, remove, and rename through the pinned mutation helper", async () => {
    await withTempDir("openclaw-fs-bridge-shell-write-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir, {
        rootFileName: "a.txt",
      });

      await bridge.mkdirp({ filePath: "nested" });
      await bridge.remove({ filePath: "nested/file.txt" });
      await bridge.rename({ from: "a.txt", to: "nested/b.txt" });

      const scripts = getScriptsFromCalls();
      expect(countMatching(scripts, (script) => script.includes("operation = sys.argv[1]"))).toBe(
        3,
      );
      expectNoScriptsContaining(scripts, 'mkdir -p -- "$2"');
      expectNoScriptsContaining(scripts, 'rm -f -- "$2"');
      expectNoScriptsContaining(scripts, 'mv -- "$3" "$2/$4"');
    });
  });

  it("re-validates target before the pinned write helper runs", async () => {
    mockedOpenRootFile
      .mockImplementationOnce(async () => ({ ok: false, reason: "path" }))
      .mockImplementationOnce(async () => ({
        ok: false,
        reason: "validation",
        error: new Error("Hardlinked path is not allowed"),
      }));

    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
    await expect(bridge.writeFile({ filePath: "b.txt", data: "hello" })).rejects.toThrow(
      /hardlinked path/i,
    );

    const scripts = getScriptsFromCalls();
    expectNoScriptsContaining(scripts, "os.replace(");
  });
});
