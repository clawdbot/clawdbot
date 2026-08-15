import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  createWorkerWorkspaceRsyncReceiverPathFactory,
  WORKER_WORKSPACE_RSYNC_DESTINATION,
  workerAcceptedWorkspaceRsyncReceiverPath,
  workerWorkspaceRsyncReceiverEntryPath,
} from "./workspace-sync-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const BUNDLE_HASH = "a".repeat(64);

describe.skipIf(process.platform === "win32")("workspace rsync receiver path", () => {
  it.each([
    { mode: "workspace-root", sourceKind: "directory" },
    { mode: "git-pack", sourceKind: "file" },
    { mode: "accepted-next", sourceKind: "file" },
  ] as const)("crosses the real rsync and OpenSSH argv boundary for $mode", async (testCase) => {
    const root = path.join(tempDirs.make("openclaw-rsync-path-"), "paths with spaces");
    const home = path.join(root, "remote home");
    const workspace = path.join(home, ".openclaw-worker/workspaces/env/session/1");
    const source = path.join(
      root,
      testCase.sourceKind === "directory" ? "source dir" : "input.bin",
    );
    const tools = tempDirs.make("openclaw-rsync-tools-");
    const sshArgvPath = path.join(root, "ssh-argv");
    const receiverArgvPath = path.join(root, "receiver-argv");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(tools, { recursive: true });
    const canonicalHome = await fs.realpath(home);
    const canonicalWorkspace = await fs.realpath(workspace);
    const remoteRelative = path.posix.relative(canonicalHome, canonicalWorkspace);
    const nonce = "b".repeat(32);
    const receiverEntryPath = workerWorkspaceRsyncReceiverEntryPath(BUNDLE_HASH);
    const installRoot = path.join(canonicalHome, ".openclaw-worker", BUNDLE_HASH);
    const receiverEntry = path.join(canonicalHome, receiverEntryPath);
    await fs.mkdir(path.dirname(receiverEntry), { recursive: true });
    await fs.writeFile(path.join(installRoot, "package.json"), '{"type":"module"}\n');
    const tsxApi = import.meta.resolve("tsx/esm/api");
    const sourceEntry = pathToFileURL(path.resolve("src/worker/workspace-rsync-receiver.ts")).href;
    await fs.writeFile(
      receiverEntry,
      `import { tsImport } from ${JSON.stringify(tsxApi)};\nawait tsImport(${JSON.stringify(sourceEntry)}, import.meta.url);\n`,
    );

    const resolvedRsync = await runCommandWithTimeout(["sh", "-c", "command -v rsync"], {
      timeoutMs: 10_000,
    });
    expect(resolvedRsync).toMatchObject({ termination: "exit", code: 0 });
    const rsync = resolvedRsync.stdout.trim();
    await fs.writeFile(
      path.join(tools, "rsync"),
      '#!/bin/sh\nset -eu\nprintf "%s\\0" "$@" > "$OPENCLAW_TEST_RECEIVER_ARGV"\nexec "$OPENCLAW_TEST_REAL_RSYNC" "$@"\n',
      { mode: 0o755 },
    );
    const fakeSsh = path.join(tools, "ssh");
    await fs.writeFile(
      fakeSsh,
      '#!/bin/sh\nset -eu\nshift\nprintf "%s\\0" "$@" > "$OPENCLAW_TEST_SSH_ARGV"\ncd "$HOME"\nexec sh -c "$*"\n',
      { mode: 0o755 },
    );

    let receiverCommand: string;
    let receiverTarget: string;
    if (testCase.mode === "accepted-next") {
      const workspaceKey = createHash("sha256").update(canonicalWorkspace).digest("hex");
      const transaction = path.join(
        path.dirname(canonicalWorkspace),
        `.openclaw-accepted-${workspaceKey}-${nonce}`,
      );
      receiverTarget = path.join(transaction, "next");
      await fs.mkdir(receiverTarget, { recursive: true });
      await fs.writeFile(
        path.join(transaction, "phase.json"),
        JSON.stringify({ version: 1, nonce, phase: "begun" }),
      );
      receiverCommand = workerAcceptedWorkspaceRsyncReceiverPath({
        receiverEntryPath,
        remoteWorkspaceDir: canonicalWorkspace,
        nonce,
      });
    } else {
      receiverTarget =
        testCase.mode === "git-pack"
          ? path.join(canonicalWorkspace, ".openclaw-base.pack")
          : canonicalWorkspace;
      receiverCommand = createWorkerWorkspaceRsyncReceiverPathFactory({
        receiverEntryPath,
        remoteWorkspaceDir: canonicalWorkspace,
        canonicalHome,
        remoteRelative,
      })(testCase.mode);
    }

    const contents = `received through ${testCase.mode}\n`;
    if (testCase.sourceKind === "directory") {
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "payload.txt"), contents);
    } else {
      await fs.writeFile(source, contents);
    }
    const result = await runCommandWithTimeout(
      [
        rsync,
        "--archive",
        "--checksum",
        `--rsync-path=${receiverCommand}`,
        "-e",
        fakeSsh,
        "--",
        testCase.sourceKind === "directory" ? `${source}/` : source,
        `test:${WORKER_WORKSPACE_RSYNC_DESTINATION}`,
      ],
      {
        timeoutMs: 30_000,
        baseEnv: {
          ...process.env,
          HOME: canonicalHome,
          PATH: `${tools}:${process.env.PATH ?? ""}`,
          OPENCLAW_TEST_REAL_RSYNC: rsync,
          OPENCLAW_TEST_RECEIVER_ARGV: receiverArgvPath,
          OPENCLAW_TEST_SSH_ARGV: sshArgvPath,
        },
      },
    );
    expect(result).toMatchObject({ termination: "exit", code: 0 });
    const receivedPath =
      testCase.mode === "workspace-root"
        ? path.join(receiverTarget, "payload.txt")
        : testCase.mode === "accepted-next"
          ? path.join(receiverTarget, path.basename(source))
          : receiverTarget;
    await expect(fs.readFile(receivedPath, "utf8")).resolves.toBe(contents);

    const sshArgv = (await fs.readFile(sshArgvPath)).toString().split("\0").filter(Boolean);
    expect(sshArgv.join(" ")).toMatch(
      /^node [A-Za-z0-9_./-]+ (?:workspace-root|git-pack|accepted-next) [A-Za-z0-9_-]+ [a-f0-9]{32} --server /u,
    );
    expect(sshArgv.at(-1)).toBe(WORKER_WORKSPACE_RSYNC_DESTINATION);
    expect(sshArgv.join(" ")).not.toContain(canonicalWorkspace);
    const receiverArgv = (await fs.readFile(receiverArgvPath))
      .toString()
      .split("\0")
      .filter(Boolean);
    expect(receiverArgv.at(-1)).toBe(receiverTarget);
    await expect(
      fs.access(path.join(canonicalHome, WORKER_WORKSPACE_RSYNC_DESTINATION)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
