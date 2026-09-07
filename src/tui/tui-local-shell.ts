// Launches and manages the local shell process used by TUI local mode.
import { randomUUID } from "node:crypto";
import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { getProcessSupervisor, type ManagedRun } from "../process/supervisor/index.js";
import { createSearchableSelectList } from "./components/selectors.js";
import { formatTuiErrorMessage } from "./tui-formatters.js";

type LocalShellDeps = {
  chatLog: {
    addSystem: (line: string) => void;
  };
  tui: {
    requestRender: () => void;
  };
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  createSelector?: (
    items: SelectItem[],
    maxVisible: number,
  ) => Component & {
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
  };
  getCwd?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  maxOutputChars?: number;
};

export function createLocalShellRunner(deps: LocalShellDeps) {
  let localExecAsked = false;
  let localExecAllowed = false;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;
  let cancelPendingApproval: (() => void) | undefined;
  const supervisor = getProcessSupervisor();
  const scopeKey = `tui-local:${randomUUID()}`;
  const cleanupScope = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
  const createSelector = deps.createSelector ?? createSearchableSelectList;
  const getCwd = deps.getCwd ?? tryProcessCwd;
  const env = deps.env ?? process.env;
  const maxChars = deps.maxOutputChars ?? 40_000;

  const ensureLocalExecAllowed = async (): Promise<boolean> => {
    if (closing || localExecAsked) {
      return localExecAllowed && !closing;
    }
    localExecAsked = true;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      deps.chatLog.addSystem("Allow local shell commands for this session?");
      deps.chatLog.addSystem(
        "This runs commands on YOUR machine (not the gateway) and may delete files or reveal secrets.",
      );
      deps.chatLog.addSystem("Select Yes/No (arrows + Enter), Esc to cancel.");
      const selector = createSelector(
        [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes" },
        ],
        2,
      );
      const finish = (allowed: boolean, message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        deps.closeOverlay(overlayHandle);
        cancelPendingApproval = undefined;
        if (allowed) {
          localExecAllowed = true;
        }
        deps.chatLog.addSystem(message);
        deps.tui.requestRender();
        resolve(allowed);
      };
      selector.onSelect = (item: SelectItem) => {
        const allowed = item.value === "yes" && !closing;
        finish(
          allowed,
          allowed ? "local shell: enabled for this session" : "local shell: not enabled",
        );
      };
      selector.onCancel = () => finish(false, "local shell: cancelled");
      const overlayHandle = deps.openOverlay(selector);
      cancelPendingApproval = selector.onCancel;
      deps.tui.requestRender();
    });
  };

  const runLocalShellLine = async (line: string) => {
    const cmd = line.slice(1);
    // NOTE: A lone '!' is handled by the submit handler as a normal message.
    // Keep this guard anyway in case this is called directly.
    if (cmd === "") {
      return;
    }

    if (localExecAsked && !localExecAllowed) {
      deps.chatLog.addSystem("local shell: not enabled for this session");
      deps.tui.requestRender();
      return;
    }

    const allowed = await ensureLocalExecAllowed();
    if (!allowed || closing) {
      return;
    }

    // A shell command's meaning depends on its directory; never retarget it implicitly.
    const cwd = getCwd();
    if (!cwd) {
      deps.chatLog.addSystem(
        "local shell: working directory was deleted; cd to an existing directory first",
      );
      deps.tui.requestRender();
      return;
    }

    deps.chatLog.addSystem(`[local] $ ${cmd}`);
    deps.tui.requestRender();

    let stdout = "";
    let stderr = "";
    let error: unknown;
    let result: Awaited<ReturnType<ManagedRun["wait"]>> | undefined;
    let run: ManagedRun | undefined;
    try {
      run = await supervisor.spawn({
        mode: "anchored-shell",
        command: cmd,
        scopeKey,
        cwd,
        env: { ...env, OPENCLAW_SHELL: "tui-local" },
        captureOutput: false,
        onStdout: (chunk) => {
          stdout = sliceUtf16Safe(stdout + chunk, -maxChars);
        },
        onStderr: (chunk) => {
          stderr = sliceUtf16Safe(stderr + chunk, -maxChars);
        },
      });
      if (closing) {
        return;
      }
      result = await run.wait();
    } catch (caught) {
      error = caught;
    } finally {
      run?.detachOutput?.();
    }
    // Keep the tail so a large stdout cannot evict a trailing stderr failure reason.
    const combined = sliceUtf16Safe(
      stdout + (stderr ? (stdout ? "\n" : "") + stderr : ""),
      -maxChars,
    ).trimEnd();

    if (combined) {
      for (const lineLocal of combined.split("\n")) {
        deps.chatLog.addSystem(`[local] ${lineLocal}`);
      }
    }
    const status = error
      ? `error: ${formatTuiErrorMessage(error)}`
      : `exit ${result?.exitCode ?? "?"}`;
    deps.chatLog.addSystem(
      `[local] ${status}${result?.exitSignal ? ` (signal ${result.exitSignal})` : ""}`,
    );
    deps.tui.requestRender();
  };

  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      closing = true;
      cancelPendingApproval?.();
      await cleanupScope();
    })());

  return { runLocalShellLine, shutdown };
}
