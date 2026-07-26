import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  foldPostCoreFinalizeIntoResult,
  runPostCoreFinalizeAfterGatewayUpdate,
} from "./update-post-core-finalize.js";
import type { UpdateRunResult } from "./update-runner.js";

function gitOkResult(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return {
    status: "ok",
    mode: "git",
    root: "/srv/openclaw",
    before: { sha: "aaa", version: "2026.5.3" },
    after: { sha: "bbb", version: "2026.6.1" },
    steps: [],
    durationMs: 10,
    ...overrides,
  };
}

const ENTRYPOINT = "/srv/openclaw/dist/index.mjs";
const resolveEntrypointOk = async () => ENTRYPOINT;
type PostCoreFinalizeSpawner = NonNullable<
  Parameters<typeof runPostCoreFinalizeAfterGatewayUpdate>[0]["spawnFinalize"]
>;

describe("runPostCoreFinalizeAfterGatewayUpdate", () => {
  it("skips non-git update modes", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>();
    for (const result of [
      gitOkResult({ mode: "pnpm" }),
      gitOkResult({ status: "error" }),
      gitOkResult({ status: "skipped" }),
      gitOkResult({ root: undefined }),
    ]) {
      const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
        result,
        resolveEntrypoint: resolveEntrypointOk,
        spawnFinalize,
      });
      expect(outcome).toEqual({ status: "skipped", reason: "not-git-update" });
    }
    expect(spawnFinalize).not.toHaveBeenCalled();
  });

  it("retries finalization after a no-op git update", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => ({ code: 0 }));
    const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult({
        before: { sha: "same", version: "2026.6.1" },
        after: { sha: "same", version: "2026.6.1" },
      }),
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
    });
    expect(outcome).toEqual({ status: "ok", entrypoint: ENTRYPOINT });
    expect(spawnFinalize).toHaveBeenCalledTimes(1);
  });

  it("skips when no built entrypoint is found", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>();
    const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: async () => undefined,
      spawnFinalize,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "entrypoint-missing" });
    expect(spawnFinalize).not.toHaveBeenCalled();
  });

  it("spawns `update finalize` against the rebuilt binary and reports success", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => ({ code: 0 }));
    const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      channel: "stable",
      timeoutMs: 120_000,
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
    });
    expect(outcome).toEqual({ status: "ok", entrypoint: ENTRYPOINT });
    expect(spawnFinalize).toHaveBeenCalledTimes(1);
    const call = expectDefined(
      spawnFinalize.mock.calls[0],
      "spawnFinalize.mock.calls[0] test invariant",
    )[0];
    // Reconcile runs through the designed finalizer; never restarts (RPC owns
    // restart). No `--channel` — the channel is passed as effective-only via env
    // so the finalizer does not persist it.
    expect(call.argv).toEqual([
      expect.any(String),
      ENTRYPOINT,
      "update",
      "finalize",
      "--json",
      "--yes",
      "--no-restart",
      "--timeout",
      "120",
    ]);
    expect(call.argv).not.toContain("--channel");
    // Configured channel is carried as the effective convergence channel via env.
    expect(call.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL).toBe("stable");
    // Host-compat resolution is pinned to the just-installed core version.
    expect(call.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("2026.6.1");
    // Outer whole-process timeout is decoupled from the per-step --timeout (120s):
    // a generous floor so a valid multi-step finalize is not killed prematurely.
    expect(call.timeoutMs).toBe(30 * 60_000);
  });

  it("strips the gateway service identity from the finalizer child env", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => ({ code: 0 }));
    await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
      env: {
        PATH: "/usr/bin",
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_GATEWAY_SERVICE_PID: "4242",
      },
    });
    const { env } = expectDefined(
      spawnFinalize.mock.calls[0],
      "spawnFinalize.mock.calls[0] test invariant",
    )[0];
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENCLAW_SERVICE_MARKER).toBeUndefined();
    expect(env.OPENCLAW_SERVICE_KIND).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_SERVICE_PID).toBeUndefined();
  });

  it("carries the external service-repair policy into the finalizer", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => ({ code: 0 }));
    await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
      serviceRepairPolicy: "external",
    });

    expect(
      expectDefined(spawnFinalize.mock.calls[0], "spawnFinalize.mock.calls[0] test invariant")[0]
        .env.OPENCLAW_SERVICE_REPAIR_POLICY,
    ).toBe("external");
  });

  it("carries effective git/dev channel via env without --channel for a no-config update", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => ({ code: 0 }));
    await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
    });
    const call = expectDefined(
      spawnFinalize.mock.calls[0],
      "spawnFinalize.mock.calls[0] test invariant",
    )[0];
    // No configured channel → effective channel defaults to the git/dev channel
    // the core update ran on, carried via env (convergence-only, not persisted),
    // never as `--channel` (which `update finalize` would persist to openclaw.json).
    expect(call.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL).toBe("dev");
    expect(call.argv).not.toContain("--channel");
    expect(call.argv).not.toContain("--timeout");
    // No per-step timeout requested → outer backstop is the floor.
    expect(call.timeoutMs).toBe(30 * 60_000);
  });

  it("passes and removes the pre-update config payload for channel restoration", async () => {
    const preUpdateConfig = {
      sourceConfig: {
        channels: {
          whatsapp: { enabled: true },
        },
      },
      authoredConfig: {
        channels: {
          whatsapp: { enabled: true },
        },
      },
    };
    let sourceConfigPath: string | undefined;
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async ({ env }) => {
      sourceConfigPath = env.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH;
      expect(sourceConfigPath).toEqual(expect.any(String));
      await expect(fs.readFile(sourceConfigPath!, "utf-8")).resolves.toBe(
        `${JSON.stringify(preUpdateConfig)}\n`,
      );
      return { code: 0 };
    });

    await expect(
      runPostCoreFinalizeAfterGatewayUpdate({
        result: gitOkResult(),
        preUpdateConfig,
        resolveEntrypoint: resolveEntrypointOk,
        spawnFinalize,
      }),
    ).resolves.toEqual({ status: "ok", entrypoint: ENTRYPOINT });

    await expect(fs.access(sourceConfigPath!)).rejects.toThrow();
  });

  it("reports error on a non-zero finalize exit", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => ({
      code: 1,
      stderr: "convergence failed",
    }));
    const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
    });
    expect(outcome).toEqual({
      status: "error",
      reason: "nonzero-exit",
      entrypoint: ENTRYPOINT,
      exitCode: 1,
      message: "convergence failed",
    });
  });

  it("reports error when the finalize spawn throws", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => {
      throw new Error("ENOENT");
    });
    const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
    });
    expect(outcome).toEqual({
      status: "error",
      reason: "spawn-failed",
      entrypoint: ENTRYPOINT,
      message: "ENOENT",
    });
  });
});

describe("foldPostCoreFinalizeIntoResult", () => {
  it("leaves the result unchanged for ok/skipped outcomes", () => {
    const result = gitOkResult();
    expect(foldPostCoreFinalizeIntoResult(result, { status: "ok", entrypoint: ENTRYPOINT })).toBe(
      result,
    );
    expect(
      foldPostCoreFinalizeIntoResult(result, { status: "skipped", reason: "not-git-update" }),
    ).toBe(result);
  });

  it("flips status to error so the RPC restart gate is skipped", () => {
    const result = gitOkResult();
    const folded = foldPostCoreFinalizeIntoResult(result, {
      status: "error",
      reason: "nonzero-exit",
      entrypoint: ENTRYPOINT,
      exitCode: 2,
      message: "boom",
    });
    expect(folded.status).toBe("error");
    expect(folded.reason).toBe("post-core-plugin-finalize-failed");
    expect(folded.steps.at(-1)).toMatchObject({
      name: "post-core plugin finalize",
      exitCode: 2,
      stderrTail: "boom",
    });
    // Core update metadata is preserved for the sentinel.
    expect(folded.after).toEqual(result.after);
  });

  it("bounds finalizer stderr in the update result", () => {
    const folded = foldPostCoreFinalizeIntoResult(gitOkResult(), {
      status: "error",
      reason: "nonzero-exit",
      entrypoint: ENTRYPOINT,
      exitCode: 1,
      message: "x".repeat(8_001),
    });
    expect(folded.steps.at(-1)?.stderrTail).toBe(`…${"x".repeat(8_000)}`);
  });
});
