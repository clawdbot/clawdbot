import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeCopilotAuthShape,
  probeCopilotCliVersion,
  probeCopilotHomeWritable,
} from "./doctor-probes.js";

type FakeChildOptions = {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  emitErrorMessage?: string;
  /** When true, never emits close; useful for timeout tests. */
  hang?: boolean;
};

function makeFakeChild(opts: FakeChildOptions = {}) {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.kill = vi.fn();

  queueMicrotask(() => {
    if (opts.stdout) {
      emitter.stdout.emit("data", Buffer.from(opts.stdout, "utf8"));
    }
    if (opts.stderr) {
      emitter.stderr.emit("data", Buffer.from(opts.stderr, "utf8"));
    }
    if (opts.emitErrorMessage) {
      emitter.emit("error", new Error(opts.emitErrorMessage));
      return;
    }
    if (!opts.hang) {
      emitter.emit("close", opts.exitCode ?? 0, opts.signal ?? null);
    }
  });

  return emitter;
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-doctor-"));
  tempDirs.push(dir);
  return dir;
}

describe("probeCopilotCliVersion", () => {
  it("reports ok with trimmed version on exit 0 with stdout", async () => {
    const result = await probeCopilotCliVersion({
      spawnFn: () => makeFakeChild({ stdout: "  1.2.3  \n" }) as never,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe("1.2.3");
      expect(result.command).toBe("copilot");
    }
  });

  it("uses custom command and args when provided", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const result = await probeCopilotCliVersion({
      command: "my-copilot",
      args: ["-V"],
      spawnFn: ((cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args: [...args] });
        return makeFakeChild({ stdout: "9.9.9" }) as never;
      }) as never,
    });
    expect(calls).toEqual([{ cmd: "my-copilot", args: ["-V"] }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toBe("my-copilot");
    }
  });

  it("reports non-zero-exit with stderr details", async () => {
    const result = await probeCopilotCliVersion({
      spawnFn: () => makeFakeChild({ exitCode: 2, stderr: "boom: not installed" }) as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("non-zero-exit");
      expect(result.details?.exitCode).toBe(2);
      expect(result.details?.stderr).toBe("boom: not installed");
    }
  });

  it("reports empty-version when exit 0 produces no stdout", async () => {
    const result = await probeCopilotCliVersion({
      spawnFn: () => makeFakeChild({ stdout: "   \n" }) as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty-version");
    }
  });

  it("reports spawn-failed when spawnFn throws synchronously (e.g. ENOENT)", async () => {
    const result = await probeCopilotCliVersion({
      spawnFn: (() => {
        throw new Error("ENOENT: copilot not found");
      }) as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("spawn-failed");
      expect(result.details?.rawError).toContain("ENOENT");
    }
  });

  it("reports spawn-error when child emits 'error'", async () => {
    const result = await probeCopilotCliVersion({
      spawnFn: () => makeFakeChild({ emitErrorMessage: "spawn ENOEXEC" }) as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("spawn-error");
      expect(result.details?.rawError).toBe("spawn ENOEXEC");
    }
  });

  it("reports probe-timeout when child hangs past timeoutMs and kills the child", async () => {
    const fakeChild = makeFakeChild({ hang: true });
    const result = await probeCopilotCliVersion({
      timeoutMs: 10,
      spawnFn: () => fakeChild as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("probe-timeout");
      expect(result.details?.timeoutMs).toBe(10);
    }
    expect(fakeChild.kill).toHaveBeenCalled();
  });

  it("returns just the first non-empty line as version when stdout has a banner / update hint", async () => {
    const result = await probeCopilotCliVersion({
      spawnFn: () =>
        makeFakeChild({
          stdout: "GitHub Copilot CLI 1.0.48.\nRun 'copilot update' to check for updates.\n",
        }) as never,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe("GitHub Copilot CLI 1.0.48.");
      expect(result.rawStdout).toBe(
        "GitHub Copilot CLI 1.0.48.\nRun 'copilot update' to check for updates.",
      );
    }
  });

  it("does not surface rawStdout when stdout is already single-line", async () => {
    const result = await probeCopilotCliVersion({
      spawnFn: () => makeFakeChild({ stdout: "1.2.3\n" }) as never,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe("1.2.3");
      expect(result.rawStdout).toBeUndefined();
    }
  });
});

describe("probeCopilotHomeWritable", () => {
  it("reports ok when the directory exists and is writable, cleaning up after itself", async () => {
    const home = await makeTempHome();
    const result = await probeCopilotHomeWritable(home);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.copilotHome).toBe(home);
      expect(result.probedPath.startsWith(home)).toBe(true);
    }
    const entries = await fs.readdir(home);
    expect(entries).toEqual([]);
  });

  it("creates copilotHome if missing", async () => {
    const root = await makeTempHome();
    const home = path.join(root, "nested", "copilot-cfg");
    const result = await probeCopilotHomeWritable(home);
    expect(result.ok).toBe(true);
    const stat = await fs.stat(home);
    expect(stat.isDirectory()).toBe(true);
  });

  it("reports copilothome-not-writable when fs throws on mkdir", async () => {
    const result = await probeCopilotHomeWritable("/some/path", {
      fsApi: {
        mkdir: vi.fn().mockRejectedValueOnce(new Error("EPERM: not permitted")),
        writeFile: vi.fn(),
        rm: vi.fn(),
      } as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("copilothome-not-writable");
      expect(result.details?.rawError).toContain("EPERM");
    }
  });

  it("falls back to the platform default copilotHome when argument is empty or whitespace", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const result = await probeCopilotHomeWritable("   ", {
      fsApi: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile,
        rm: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.copilotHome.length).toBeGreaterThan(0);
      expect(result.copilotHome.toLowerCase()).toContain("copilot");
    }
  });
});

describe("probeCopilotAuthShape", () => {
  it("resolves to useLoggedInUser when the flag is true", () => {
    const result = probeCopilotAuthShape({ useLoggedInUser: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedMode).toBe("useLoggedInUser");
    }
  });

  it("resolves to gitHubToken when a non-empty token is supplied", () => {
    const result = probeCopilotAuthShape({ gitHubToken: "ghp_xxx" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedMode).toBe("gitHubToken");
    }
  });

  it("resolves to profile when both profileId and profileVersion are supplied", () => {
    const result = probeCopilotAuthShape({ profileId: "p1", profileVersion: "v1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedMode).toBe("profile");
    }
  });

  it("rejects when no auth source is provided", () => {
    const result = probeCopilotAuthShape({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no-auth-source");
    }
  });

  it("rejects when only one of profileId / profileVersion is provided", () => {
    expect(probeCopilotAuthShape({ profileId: "p1" }).ok).toBe(false);
    expect(probeCopilotAuthShape({ profileVersion: "v1" }).ok).toBe(false);
  });

  it("rejects useLoggedInUser:false on its own", () => {
    const result = probeCopilotAuthShape({ useLoggedInUser: false });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty gitHubToken string", () => {
    const result = probeCopilotAuthShape({ gitHubToken: "" });
    expect(result.ok).toBe(false);
  });
});
