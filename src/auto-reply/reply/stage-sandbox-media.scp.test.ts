import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as globals from "../../globals.js";
import * as mediaRoots from "../../media/channel-inbound-roots.js";
import * as mediaReference from "../../media/media-reference.js";
import * as execSpawn from "../../process/exec-spawn.js";
import * as processExec from "../../process/exec.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  killPidIfAlive,
  readPidFile,
  waitForPidFile,
  waitForPidToExit,
} from "../../test-utils/process-tree.js";
import type { RuntimeMsgContext, TemplateContext } from "../templating.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";

const SCP_STDERR_TAIL_CHARS = 16_384;
const REMOTE_PATH = "/synthetic/attachments/report with spaces.txt";
const SUCCESS = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit",
} satisfies Awaited<ReturnType<typeof processExec.runCommandWithTimeout>>;

const hasUnpairedUtf16Surrogate = (text: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

function remoteStageParams(state: OpenClawTestState, abortSignal?: AbortSignal) {
  vi.spyOn(mediaRoots, "resolveChannelRemoteInboundAttachmentRoots").mockReturnValue([
    "/synthetic/attachments",
  ]);
  const ctx: RuntimeMsgContext = {
    Body: "synthetic attachment",
    MediaRemoteHost: "user@gateway-host",
    media: [{ path: REMOTE_PATH, url: REMOTE_PATH, contentType: "text/plain" }],
  };
  const sessionCtx: TemplateContext = structuredClone(ctx);
  return {
    ctx,
    sessionCtx,
    cfg: {
      agents: {
        ownership: "explicit" as const,
        entries: { main: {} },
        defaults: {
          skipBootstrap: true,
          sandbox: {
            mode: "all" as const,
            scope: "agent" as const,
            workspaceRoot: state.path("sandbox"),
            workspaceAccess: "none" as const,
          },
        },
      },
    },
    agentId: "main",
    sessionKey: "agent:main:scp-fixture",
    workspaceDir: state.workspaceDir,
    abortSignal,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("stageSandboxMedia SCP", () => {
  it("stages bytes and both contexts through the strict bounded SCP command", async () => {
    await withOpenClawTestState({ label: "scp-stage" }, async (state) => {
      const params = remoteStageParams(state);
      let download = "";
      const runScp = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockImplementation(async (argv) => {
          download = argv.at(-1)!;
          await fs.writeFile(download, "synthetic attachment bytes");
          return SUCCESS;
        });

      const result = await stageSandboxMedia(params);

      expect(runScp).toHaveBeenCalledExactlyOnceWith(
        [
          "scp",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "--",
          `user@gateway-host:${REMOTE_PATH}`,
          download,
        ],
        expect.objectContaining({
          maxOutputBytes: { stdout: 1, stderr: SCP_STDERR_TAIL_CHARS * 4 },
        }),
      );
      const fact = params.ctx.media?.[0];
      expect(fact).toMatchObject({ staged: true, contentType: "text/plain" });
      expect(fact?.path).toBe(result.staged.get(0));
      expect(fact?.url).toBe(fact?.path);
      expect(fact?.workspaceDir?.startsWith(state.path("sandbox"))).toBe(true);
      expect(params.sessionCtx.media).toEqual(params.ctx.media);
      expect(await fs.readFile(path.join(fact!.workspaceDir!, fact!.path!), "utf8")).toBe(
        "synthetic attachment bytes",
      );
      await expect(fs.stat(path.dirname(download))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("logs a bounded UTF-16-safe diagnostic without publishing failed media", async () => {
    await withOpenClawTestState({ label: "scp-stderr" }, async (state) => {
      const params = remoteStageParams(state);
      const before = structuredClone([params.ctx, params.sessionCtx]);
      // The retained window starts on the emoji's low surrogate.
      const stderr = "n".repeat(99) + "🤖" + "n".repeat(SCP_STDERR_TAIL_CHARS - 5) + "fail";
      const runScp = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockResolvedValue({ ...SUCCESS, code: 1, stderr });
      const log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});

      expect((await stageSandboxMedia(params)).staged.size).toBe(0);

      expect(runScp).toHaveBeenCalledTimes(3);
      const prefix = `Failed to stage inbound media path ${REMOTE_PATH}: Error: scp failed (1): `;
      const message = log.mock.calls.find(([value]) => value.startsWith(prefix))?.[0] ?? "";
      expect(message.startsWith(prefix)).toBe(true);
      expect(message).toContain("fail");
      expect(message).not.toContain("🤖");
      expect(message.length).toBeLessThanOrEqual(prefix.length + SCP_STDERR_TAIL_CHARS);
      expect(hasUnpairedUtf16Surrogate(message)).toBe(false);
      expect([params.ctx, params.sessionCtx]).toEqual(before);
    });
  });

  it.each([
    { failure: "spawn", cancel: false },
    { failure: "spawn", cancel: true },
    { failure: "exit", cancel: true },
  ])(
    "retains an ordinary $failure error when cancellation coincides: $cancel",
    async ({ failure, cancel }) => {
      await withOpenClawTestState({ label: "scp-error" }, async (state) => {
        const controller = new AbortController();
        const params = remoteStageParams(state, controller.signal);
        const before = structuredClone([params.ctx, params.sessionCtx]);
        const spawnError = new Error("synthetic spawn failure");
        const reason = new Error("distinct synthetic cancellation");
        const runScp = vi
          .spyOn(processExec, "runCommandWithTimeout")
          .mockImplementation(async () => {
            if (cancel) {
              controller.abort(reason);
            }
            if (failure === "spawn") {
              throw spawnError;
            }
            return {
              ...SUCCESS,
              code: 1,
              signal: null,
              termination: "signal",
              stderr: "synthetic transfer failure",
            };
          });
        const log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});

        if (cancel) {
          await expect.soft(stageSandboxMedia(params)).rejects.toBe(reason);
        } else {
          expect((await stageSandboxMedia(params)).staged.size).toBe(0);
        }

        expect(runScp).toHaveBeenCalledTimes(cancel ? 1 : 3);
        const diagnostic =
          failure === "spawn"
            ? String(spawnError)
            : "Error: scp failed (1): synthetic transfer failure";
        expect(log).toHaveBeenCalledWith(
          `Failed to stage inbound media path ${REMOTE_PATH}: ${diagnostic}`,
        );
        expect(log.mock.calls.flat().join("\n")).not.toContain(reason.message);
        expect([params.ctx, params.sessionCtx]).toEqual(before);
      });
    },
  );

  it("retains cancellation when the final source is skipped by path policy", async () => {
    await withOpenClawTestState({ label: "stage-skipped-source-cancel" }, async (state) => {
      const sourcePath = await state.writeText("outside/blocked.txt", "must not be staged");
      const ctx: RuntimeMsgContext = { media: [{ path: sourcePath }] };
      const sessionCtx: TemplateContext = structuredClone(ctx);
      const before = structuredClone([ctx, sessionCtx]);
      const controller = new AbortController();
      const reason = "synthetic cancellation while resolving the final source";
      const resolveReference = mediaReference.resolveInboundMediaReference;
      const resolver = vi
        .spyOn(mediaReference, "resolveInboundMediaReference")
        .mockImplementation(async (source) => {
          const reference = await resolveReference(source);
          if (source === sourcePath) {
            controller.abort(reason);
          }
          return reference;
        });
      const log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});

      await expect
        .soft(
          stageSandboxMedia({
            ctx,
            sessionCtx,
            cfg: {},
            sessionKey: "agent:main:skipped-source-fixture",
            workspaceDir: state.workspaceDir,
            abortSignal: controller.signal,
          }),
        )
        .rejects.toBe(reason);

      expect(resolver).toHaveBeenCalledWith(sourcePath);
      expect(log).toHaveBeenCalledWith(
        `Blocking attempt to stage media from outside media directory: ${sourcePath}`,
      );
      expect(await fs.readdir(state.workspaceDir, { recursive: true })).toEqual([]);
      expect([ctx, sessionCtx]).toEqual(before);
    });
  });

  it("rejects a pre-aborted request without starting SCP or publishing media", async () => {
    await withOpenClawTestState({ label: "scp-pre-aborted" }, async (state) => {
      const controller = new AbortController();
      const params = remoteStageParams(state, controller.signal);
      const before = structuredClone([params.ctx, params.sessionCtx]);
      const runScp = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockImplementation(async (argv) => {
          await fs.writeFile(argv.at(-1)!, "unexpected transfer");
          return SUCCESS;
        });
      const reason = "synthetic cancellation before staging";
      controller.abort(reason);

      await expect(stageSandboxMedia(params)).rejects.toBe(reason);

      expect(runScp).not.toHaveBeenCalled();
      expect([params.ctx, params.sessionCtx]).toEqual(before);
    });
  });

  it("preserves cancellation after the runner has settled without retrying", async () => {
    await withOpenClawTestState({ label: "scp-cancelled-result" }, async (state) => {
      const controller = new AbortController();
      const params = remoteStageParams(state, controller.signal);
      const before = structuredClone([params.ctx, params.sessionCtx]);
      const reason = new Error("synthetic cancelled transfer");
      const runScp = vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async () => {
        controller.abort(reason);
        return { ...SUCCESS, code: null, signal: "SIGTERM", killed: true, termination: "signal" };
      });

      await expect(stageSandboxMedia(params)).rejects.toBe(reason);

      expect(runScp).toHaveBeenCalledTimes(1);
      expect([params.ctx, params.sessionCtx]).toEqual(before);
    });
  });

  it.each([
    {
      name: "does not publish staged facts after cancellation during final URL-alias resolution",
      followingFile: false,
    },
    {
      name: "does not copy a following local file after cancellation during URL-alias resolution",
      followingFile: true,
    },
  ])("$name", async ({ followingFile }) => {
    await withOpenClawTestState({ label: "stage-alias-cancel" }, async (state) => {
      const fileName = "alias-source.txt";
      const sourcePath = await state.writeText(`media/inbound/${fileName}`, "local attachment");
      const alias = `media://inbound/${fileName}`;
      const followingPath = followingFile
        ? await state.writeText("media/inbound/after-cancel.txt", "must not be staged")
        : undefined;
      const ctx: RuntimeMsgContext = {
        media: [
          { path: sourcePath, url: alias },
          ...(followingPath ? [{ path: followingPath }] : []),
        ],
      };
      const sessionCtx: TemplateContext = structuredClone(ctx);
      const before = structuredClone([ctx, sessionCtx]);
      const controller = new AbortController();
      const reason = new Error("synthetic cancellation while resolving alias");
      const resolveReference = mediaReference.resolveInboundMediaReference;
      const resolver = vi
        .spyOn(mediaReference, "resolveInboundMediaReference")
        .mockImplementation(async (source) => {
          const reference = await resolveReference(source);
          if (source === alias) {
            controller.abort(reason);
          }
          return reference;
        });
      const params = {
        ctx,
        sessionCtx,
        cfg: {},
        sessionKey: "agent:main:alias-fixture",
        workspaceDir: state.workspaceDir,
        abortSignal: controller.signal,
      };
      const outcome = await stageSandboxMedia(params).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      expect(resolver).toHaveBeenCalledWith(alias);
      // Disk staging may already be complete; cancellation forbids publishing its facts.
      const stagedFiles = await fs.readdir(state.workspaceDir, { recursive: true });
      const copied = stagedFiles.find((file) => file.endsWith("input-alias-source.txt"));
      expect(copied).toBeDefined();
      expect(await fs.readFile(path.join(state.workspaceDir, copied!), "utf8")).toBe(
        "local attachment",
      );
      if (followingPath) {
        expect(stagedFiles.some((file) => file.endsWith("input-after-cancel.txt"))).toBe(false);
      }
      expect([ctx, sessionCtx]).toEqual(before);
      expect(outcome).toEqual({ error: reason });
    });
  });

  it.runIf(process.platform !== "win32")(
    "owns the real SCP tree through cancellation and cleanup",
    async () => {
      await withOpenClawTestState({ label: "scp-process-tree" }, async (state) => {
        const params = remoteStageParams(state);
        const before = structuredClone([params.ctx, params.sessionCtx]);
        const binDir = state.path("bin");
        const attemptsPath = state.path("attempts");
        const parentPidPath = state.path("parent.pid");
        const descendantPidPath = state.path("descendant.pid");
        const readyPath = state.path("ready.pid");
        const cleanupPath = state.path("cleanup");
        const downloadPath = state.path("download-path");
        await fs.mkdir(binDir);
        const descendantSource = [
          "const fs = require('node:fs')",
          `const cleanup = () => { if (fs.existsSync(${JSON.stringify(cleanupPath)})) process.exit(0) }`,
          "process.on('disconnect', cleanup); cleanup()",
          "process.on('SIGTERM', () => {})",
          "setInterval(() => {}, 1000)",
          "process.send('ready')",
        ].join(";");
        await fs.writeFile(
          path.join(binDir, "scp"),
          [
            `#!${process.execPath}`,
            "const fs = require('node:fs'); const { spawn } = require('node:child_process');",
            `const retried = fs.existsSync(${JSON.stringify(attemptsPath)});`,
            `fs.appendFileSync(${JSON.stringify(attemptsPath)}, 'attempt\\n');`,
            `if (retried || fs.existsSync(${JSON.stringify(cleanupPath)})) process.exit(1);`,
            `fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));`,
            `fs.writeFileSync(${JSON.stringify(downloadPath)}, process.argv.at(-1));`,
            "process.on('SIGTERM', () => {});",
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
            `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
            `child.once('message', () => fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)));`,
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          { mode: 0o700 },
        );

        await withEnvAsync(
          { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
          async () => {
            const controller = new AbortController();
            const reason = "synthetic operator cancellation";
            params.abortSignal = controller.signal;
            const spawn = vi.spyOn(execSpawn, "spawnCommandWithInvocation");
            let parentPid: number | undefined;
            let descendantPid: number | undefined;
            const alive = () =>
              [parentPid, descendantPid].some((pid) => pid !== undefined && isPidAlive(pid));
            const settled = stageSandboxMedia(params).then(
              (value) => ({ value, aliveAtSettlement: alive() }),
              (error: unknown) => ({ error, aliveAtSettlement: alive() }),
            );
            let exitedBeforeCleanup: boolean[] = [];
            let temporaryDirectoryRemoved = false;
            try {
              parentPid = await waitForPidFile(parentPidPath);
              descendantPid = await waitForPidFile(descendantPidPath);
              expect(await waitForPidFile(readyPath)).toBe(parentPid);
              expect(isPidAlive(parentPid)).toBe(true);
              expect(isPidAlive(descendantPid)).toBe(true);
              controller.abort(reason);
              exitedBeforeCleanup = await Promise.all([
                waitForPidToExit(parentPid),
                waitForPidToExit(descendantPid),
              ]);
            } finally {
              // Stop any late attempt, then drain the owner before removing its fixture.
              await fs.writeFile(cleanupPath, "cleanup");
              for (const [index, result] of spawn.mock.results.entries()) {
                if (spawn.mock.calls[index]?.[0][0] === "scp" && result.type === "return") {
                  killPidIfAlive(result.value.child.nodeChildProcess.pid);
                }
              }
              descendantPid ??= await readPidFile(descendantPidPath).catch(() => undefined);
              killPidIfAlive(descendantPid);
              await settled;
              if (existsSync(downloadPath)) {
                const download = await fs.readFile(downloadPath, "utf8");
                const temporaryDirectory = path.dirname(download);
                temporaryDirectoryRemoved = !existsSync(temporaryDirectory);
                await fs.rm(temporaryDirectory, { recursive: true, force: true });
              }
            }

            expect(exitedBeforeCleanup).toEqual([true, true]);
            expect(await settled).toEqual({ error: reason, aliveAtSettlement: false });
            expect(await fs.readFile(attemptsPath, "utf8")).toBe("attempt\n");
            expect([params.ctx, params.sessionCtx]).toEqual(before);
            expect(alive()).toBe(false);
            expect(temporaryDirectoryRemoved).toBe(true);
          },
        );
      });
    },
  );
});
