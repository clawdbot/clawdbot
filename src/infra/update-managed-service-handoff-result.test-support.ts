import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ManagedServiceManagerBoundaryOptions,
  ManagedServiceManagerBoundaryResult,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import type { UpdateRunResult } from "./update-runner-types.js";

export function registerManagedTerminalResultTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd" | "launchd",
    options?: ManagedServiceManagerBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
  tempDirs: Set<string>,
): void {
  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      (["git", "npm"] as const).flatMap((mode) =>
        (["same", "replacement", "replacement-symlink"] as const).flatMap((rootKind) =>
          (["published", "consumed"] as const).map((updaterNotification) => ({
            kind,
            mode,
            rootKind,
            updaterNotification,
          })),
        ),
      ),
    ),
  )(
    "$kind preserves completed $mode success at $rootKind root (notification=$updaterNotification)",
    async ({ kind, mode, rootKind, updaterNotification }) => {
      let root: string | undefined;
      if (rootKind !== "same") {
        const replacement = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-replacement-")),
        );
        tempDirs.add(replacement);
        root = path.join(replacement, "checkout");
        await fs.mkdir(root);
        if (rootKind === "replacement-symlink") {
          const link = path.join(replacement, "global-package");
          await fs.symlink(root, link, "dir");
          expect(await fs.realpath(link)).toBe(root);
          root = link;
        }
      }
      const updaterResult = {
        status: "ok",
        mode,
        ...(root ? { root } : {}),
        before: { version: "1.0.0", ...(mode === "git" ? { sha: "a".repeat(40) } : {}) },
        after: {
          version: "1.1.0",
          ...(mode === "git" ? { sha: "b".repeat(40), buildId: "updated-git-build" } : {}),
        },
        steps: [],
        durationMs: 100,
      } satisfies UpdateRunResult;
      const { commands, state, sentinel } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: 0,
        updaterResult,
        updaterNotification,
        recordedFailure: { error: "A diagnostic export cannot override direct success." },
      });
      expect(
        commands.some((command) =>
          /(?:^| )(?:start|reset-failed|enable|bootstrap|kickstart)(?: |$)/.test(command),
        ),
      ).toBe(false);
      expect(state.restored).toBeUndefined();
      expect(state.healthProbed).toBeUndefined();
      expect(state.triageCalls).toBeUndefined();
      expect(state.publishedSentinel).toMatchObject({ payload: { status: "ok", stats: { mode } } });
      if (updaterNotification === "consumed") {
        expect(state.consumedNotifications).toBe(1);
        expect(sentinel).toBeNull();
      } else {
        expect(state.consumedNotifications).toBeUndefined();
        expect(sentinel).toEqual(state.publishedSentinel);
      }
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      (["error", "skipped"] as const).map((status) => ({ kind, status })),
    ),
  )(
    "$kind rejects foreign-root $status recovery despite positive runtime proof",
    async ({ kind, status }) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-foreign-")),
      );
      tempDirs.add(root);
      const { commands, state, sentinel } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: status === "skipped" ? 0 : 7,
        helperExitCode: status === "skipped" ? 1 : 7,
        updaterResult: {
          status,
          root,
          mode: "git",
          steps: [],
          durationMs: 100,
          recovery: { serviceRestartSafe: true, version: "1.0.0", buildId: "original-git-build" },
        } satisfies UpdateRunResult,
        recordedFailure: {
          result: {
            status: "error",
            mode: "git",
            steps: [],
            recovery: { serviceRestartSafe: true },
          },
        },
      });
      expect(
        commands.some((command) =>
          /(?:^| )(?:start|reset-failed|enable|bootstrap|kickstart)(?: |$)/.test(command),
        ),
      ).toBe(false);
      expect(state.restored).toBeUndefined();
      expect(state.healthProbed).toBeUndefined();
      expect(state.triageCalls).toBe(1);
      expect(sentinel).toMatchObject({
        payload: { status: "error", stats: { reason: "managed-service-handoff-failed" } },
      });
    },
  );
}
