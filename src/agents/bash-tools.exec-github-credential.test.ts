import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { prepareGitHubToolEnvironment } from "./github-tool-identity.js";

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), prepare: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: boundary.spawn }),
}));
vi.mock("./shell-snapshot.js", () => ({
  maybeWrapCommandWithShellSnapshot: async (input: { command: string; env: unknown }) => {
    await boundary.prepare(input);
    return input.command;
  },
}));

let root: string;
let profileDir: string;
let hostsPath: string;
const safeMessage =
  "GitHub Identity credential is unavailable or insecure. Reconnect or change GitHub Identity, then retry.";

async function writeToken(token = "synthetic-launch-token") {
  await fs.writeFile(hostsPath, `github.com:\n  oauth_token: ${token}\n`, { mode: 0o600 });
}

let supervisor: ReturnType<typeof createProcessSupervisor>;
let command: string;

function launch(overrides: Partial<Parameters<typeof runExecProcess>[0]> = {}) {
  return runExecProcess({
    command,
    workdir: root,
    env: {
      HOME: root,
      ZDOTDIR: root,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GH_CONFIG_DIR: profileDir,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
    githubProfileDir: profileDir,
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: 5,
    ...overrides,
  });
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "exec-private-credential-")));
  profileDir = path.join(root, "profile");
  hostsPath = path.join(profileDir, "hosts.yml");
  await fs.mkdir(profileDir, { mode: 0o700 });
  await writeToken();
  supervisor = createProcessSupervisor();
  boundary.spawn.mockReset().mockImplementation(supervisor.spawn.bind(supervisor));
  const fixture = path.join(root, "credential-outcome.cjs");
  await fs.writeFile(
    fixture,
    `
    const accounts = new Map([
      ["synthetic-launch-token", "selected"], ["synthetic-rotated-token", "rotated"],
      ["synthetic-fallback-token", "fallback"], ["synthetic-native-token", "native"],
    ]);
    process.stdout.write(accounts.get(process.env.GH_TOKEN) || "wrong-account");
  `,
  );
  command = [process.execPath, fixture].map(quoteCliArg).join(" ");
  boundary.prepare.mockReset();
});
afterEach(async () => {
  await supervisor.shutdown();
  resetProcessRegistryForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("local GitHub credential launch boundary", () => {
  it.each([false, true])(
    "keeps prepared, requested and snapshot environments secretless (pty=%s)",
    async (usePty) => {
      const prepared = prepareGitHubToolEnvironment({
        config: { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } },
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: root },
      });
      profileDir = expectDefined(prepared.localIdentityEnv.GH_CONFIG_DIR, "managed GitHub profile");
      hostsPath = path.join(profileDir, "hosts.yml");
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      await writeToken();
      const resolved = resolvePreparedExecEnvironment({
        execParams: { command: "echo synthetic" },
        host: "gateway",
        defaultPathPrepend: [],
        ...prepared,
        warnings: [],
      });
      const original = JSON.stringify({ prepared, resolved });
      Object.freeze(resolved.env);
      Object.freeze(resolved.requestedEnv);
      boundary.prepare.mockImplementation(async ({ env }) => {
        expect(env.GH_TOKEN).toBe("");
        // Rotation during async shell preparation must precede the private snapshot.
        await writeToken("synthetic-rotated-token");
      });
      const beforeSpawn = vi.fn(async () => {
        expect(JSON.stringify({ prepared, resolved })).toBe(original);
        await writeToken("synthetic-rotated-token");
        return undefined;
      });
      boundary.spawn.mockImplementationOnce((input: SpawnInput) => {
        expect(input.env?.GH_TOKEN).toBe("");
        expect(input.env?.GITHUB_TOKEN).toBe("");
        expect(input.env?.PATH).toBe(resolved.env.PATH);
        return supervisor.spawn(input);
      });
      const run = await launch({ env: resolved.env, usePty, beforeSpawn });
      expect((await run.promise).aggregated).toBe("rotated");
      expect(beforeSpawn).toHaveBeenCalledOnce();
      expect(JSON.stringify({ prepared, resolved })).toBe(original);
      expect(JSON.stringify({ run, calls: boundary.spawn.mock.calls })).not.toContain(
        "synthetic-rotated-token",
      );
    },
  );

  it.each(["rotate", "remove"])("rereads credentials on PTY fallback after %s", async (change) => {
    boundary.spawn
      .mockImplementationOnce(async (input: SpawnInput) => {
        expect(input.env?.GH_TOKEN).toBe("");
        if (change === "rotate") {
          await writeToken("synthetic-fallback-token");
        } else {
          await fs.rm(hostsPath);
        }
        throw new Error("synthetic PTY unavailable");
      })
      .mockImplementationOnce((input: SpawnInput) => {
        expect(input.mode).toBe("child");
        expect(input.env?.GH_TOKEN).toBe("");
        return supervisor.spawn(input);
      });
    const beforeSpawn = vi.fn(async () => undefined);
    const outcome = await (await launch({ usePty: true, beforeSpawn })).promise;
    expect(outcome.exitCode).toBe(change === "remove" ? 1 : 0);
    expect(outcome.aggregated).toContain(change === "remove" ? safeMessage : "fallback");
    expect(boundary.spawn).toHaveBeenCalledTimes(2);
    expect(beforeSpawn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(boundary.spawn.mock.calls)).not.toContain("synthetic-launch-token");
    expect(JSON.stringify(boundary.spawn.mock.calls)).not.toContain("synthetic-fallback-token");
  });

  it.each(["deny", "abort"])("does not launch or retry a PTY preflight %s", async (failure) => {
    const controller = new AbortController();
    const beforeSpawn = vi.fn(async () => {
      await fs.rm(hostsPath);
      if (failure === "abort") {
        controller.abort(new Error("synthetic cancellation"));
      } else {
        throw new Error("synthetic refusal");
      }
      return undefined;
    });
    const warnings: string[] = [];
    await expect(
      launch({ usePty: true, beforeSpawn, startupSignal: controller.signal, warnings }),
    ).rejects.toThrow(failure === "abort" ? "synthetic cancellation" : "synthetic refusal");
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it.each([
    "missing",
    "tokenless",
    "malformed",
    "number",
    "multiline",
    "nul",
    "other-host",
    "duplicate",
    "multiple-documents",
    "alias",
    "oversize",
    "symlink-file",
    "symlink-directory",
    "hardlink",
    "public-file",
    "public-directory",
    "directory-file",
  ])("refuses a %s profile without secret-bearing diagnostics or PTY retry", async (fault) => {
    const yaml: Record<string, string> = {
      tokenless: "github.com: {}",
      malformed: "github.com: [synthetic-secret: ",
      number: "github.com: { oauth_token: 123 }",
      multiline: 'github.com: { oauth_token: "synthetic\\nsecret" }',
      nul: 'github.com: { oauth_token: "synthetic\\0secret" }',
      "other-host": "example.com: { oauth_token: synthetic-secret }",
      duplicate: "github.com: {}\ngithub.com: { oauth_token: synthetic-secret }",
      "multiple-documents": "github.com: {}\n---\ngithub.com: { oauth_token: synthetic-secret }",
      alias: "token: &token synthetic-secret\ngithub.com: { oauth_token: *token }",
      oversize: "#" + "synthetic-secret".repeat(5000),
    };
    if (yaml[fault]) {
      await fs.writeFile(hostsPath, yaml[fault]);
    } else if (fault === "missing") {
      await fs.rm(hostsPath);
    } else if (fault === "public-file") {
      await fs.chmod(hostsPath, 0o644);
    } else if (fault === "public-directory") {
      await fs.chmod(profileDir, 0o755);
    } else if (fault === "hardlink") {
      await fs.link(hostsPath, path.join(root, "hardlink"));
    } else if (fault === "directory-file") {
      await fs.rm(hostsPath);
      await fs.mkdir(hostsPath);
    } else {
      const target = fault === "symlink-file" ? hostsPath : profileDir;
      await fs.rename(target, `${target}-real`);
      await fs.symlink(`${target}-real`, target);
    }
    const beforeSpawn = vi.fn(async () => undefined);
    const warnings: string[] = [];
    const outcome = await (await launch({ usePty: true, beforeSpawn, warnings })).promise;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.aggregated).toBe(`${safeMessage}\n\n(Command exited with code 1)`);
    expect(warnings).toEqual([]);
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(boundary.spawn).toHaveBeenCalledOnce();
  });

  it("does not infer a managed binding from arbitrary GH_CONFIG_DIR", async () => {
    const env = {
      GH_CONFIG_DIR: path.join(root, "unavailable"),
      GH_TOKEN: "synthetic-native-token",
    };
    boundary.spawn.mockImplementationOnce((input: SpawnInput) => {
      expect(input.env).toMatchObject(env);
      return supervisor.spawn(input);
    });
    const outcome = await (await launch({ env, githubProfileDir: undefined })).promise;
    expect(outcome.aggregated).toBe("native");
    expect(env.GH_TOKEN).toBe("synthetic-native-token");
  });
});
