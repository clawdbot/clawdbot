// Verifies local shell process handling for TUI local mode.
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  getProcessSupervisor,
  type ManagedRun,
  type ProcessSupervisor,
} from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createLocalShellRunner } from "./tui-local-shell.js";

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: vi.fn(),
}));

type ShellSupervisor = ReturnType<typeof getProcessSupervisor>;

const createSelector = () => {
  const selector = {
    onSelect: undefined as ((item: { value: string; label: string }) => void) | undefined,
    onCancel: undefined as (() => void) | undefined,
    render: () => ["selector"],
    invalidate: () => {},
  };
  return selector;
};

function createOverlayHandle(): OverlayHandle {
  return {
    hide: vi.fn(),
    setHidden: vi.fn(),
    isHidden: vi.fn(() => false),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => true),
  };
}

function createShellHarness(params?: {
  spawn?: ProcessSupervisor["spawn"];
  supervisor?: ShellSupervisor;
  getCwd?: () => string | undefined;
  env?: Record<string, string>;
  maxOutputChars?: number;
}) {
  const messages: string[] = [];
  const chatLog = {
    addSystem: (line: string) => {
      messages.push(line);
    },
  };
  const tui = { requestRender: vi.fn() };
  const overlayHandle = createOverlayHandle();
  const openOverlay = vi.fn(() => overlayHandle);
  const closeOverlay = vi.fn();
  let lastSelector: ReturnType<typeof createSelector> | null = null;
  const createSelectorSpy = vi.fn(() => {
    lastSelector = createSelector();
    return lastSelector;
  });
  const supervisor =
    params?.supervisor ??
    ({
      spawn: params?.spawn ?? vi.fn(),
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      waitForScope: vi.fn(async () => {}),
      getRecord: vi.fn(),
    } satisfies ShellSupervisor);
  vi.mocked(getProcessSupervisor).mockReturnValue(supervisor);
  const { runLocalShellLine, shutdown } = createLocalShellRunner({
    chatLog,
    tui,
    openOverlay,
    closeOverlay,
    createSelector: createSelectorSpy,
    ...(params?.getCwd ? { getCwd: params.getCwd } : {}),
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.maxOutputChars !== undefined ? { maxOutputChars: params.maxOutputChars } : {}),
  });
  return {
    messages,
    openOverlay,
    overlayHandle,
    closeOverlay,
    createSelectorSpy,
    supervisor,
    runLocalShellLine,
    shutdown,
    getLastSelector: () => lastSelector,
  };
}

function createSettlingSpawn(params: { stdout?: string[]; stderr?: string[]; error?: Error }) {
  return vi.fn(async (input: SpawnInput) => {
    const exit: RunExit = {
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    };
    return {
      runId: "local-shell-run",
      startedAtMs: 0,
      wait: async () => {
        params.stdout?.forEach((chunk) => input.onStdout?.(chunk));
        params.stderr?.forEach((chunk) => input.onStderr?.(chunk));
        if (params.error) {
          throw params.error;
        }
        return exit;
      },
      cancel: vi.fn(),
      detachOutput: vi.fn(),
    } satisfies ManagedRun;
  });
}

describe("createLocalShellRunner", () => {
  it("logs denial on subsequent ! attempts without re-prompting", async () => {
    const harness = createShellHarness();

    const firstRun = harness.runLocalShellLine("!ls");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ value: "no", label: "No" });
    await firstRun;

    await harness.runLocalShellLine("!pwd");

    expect(harness.messages).toContain("local shell: not enabled");
    expect(harness.messages).toContain("local shell: not enabled for this session");
    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.spawn).not.toHaveBeenCalled();
    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandle);
  });

  it("sets OPENCLAW_SHELL when running local shell commands", async () => {
    const spawn = createSettlingSpawn({});

    const harness = createShellHarness({
      spawn,
      env: { PATH: "/tmp/bin", USER: "dev" },
    });

    const firstRun = harness.runLocalShellLine("!echo hi");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ value: "yes", label: "Yes" });
    await firstRun;

    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const input = spawn.mock.calls[0]?.[0];
    expect(input?.mode).toBe("anchored-shell");
    expect(input?.env?.OPENCLAW_SHELL).toBe("tui-local");
    expect(input?.env?.PATH).toBe("/tmp/bin");
    expect(harness.messages).toContain("local shell: enabled for this session");
  });

  it("keeps stderr visible instead of evicting it when stdout fills the output cap", async () => {
    const spawn = createSettlingSpawn({
      stdout: ["0".repeat(20)],
      stderr: ["FATAL"],
    });

    const harness = createShellHarness({
      spawn,
      maxOutputChars: 20,
    });

    const run = harness.runLocalShellLine("!noisy");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    // The failure reason in stderr must survive even though stdout filled the cap;
    // the previous head-cut kept all stdout and dropped stderr entirely.
    expect(harness.messages.some((m) => m.includes("FATAL"))).toBe(true);
  });

  it("keeps a whole code point when the combined output tail starts inside an emoji", async () => {
    const spawn = createSettlingSpawn({ stdout: ["x😀"], stderr: ["tail"] });
    const harness = createShellHarness({
      spawn,
      maxOutputChars: 6,
    });

    const run = harness.runLocalShellLine("!unicode");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    expect(harness.messages).toContain("[local] tail");
    expect(harness.messages.join("\n")).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("refuses to retarget local commands after the working directory is deleted", async () => {
    const harness = createShellHarness({ getCwd: () => undefined });

    const run = harness.runLocalShellLine("!pwd");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    expect(harness.supervisor.spawn).not.toHaveBeenCalled();
    expect(harness.messages).toContain(
      "local shell: working directory was deleted; cd to an existing directory first",
    );
  });

  it("finishes a failed run before reporting the next local command", async () => {
    const spawn = createSettlingSpawn({ stdout: ["second\n"] });
    spawn.mockRejectedValueOnce(new Error("synthetic spawn failure"));
    const harness = createShellHarness({ spawn });

    const failedRun = harness.runLocalShellLine("!echo first");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await failedRun;
    await harness.runLocalShellLine("!echo second");

    expect(harness.messages.filter((message) => message.startsWith("[local]"))).toEqual([
      "[local] $ echo first",
      expect.stringContaining("[local] error: "),
      "[local] $ echo second",
      "[local] second",
      "[local] exit 0",
    ]);
  });

  it("reports a command result failure once", async () => {
    const spawn = createSettlingSpawn({ error: new Error("synthetic failure") });
    const harness = createShellHarness({ spawn });

    const run = harness.runLocalShellLine("!cmd");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await expect(run).resolves.toBeUndefined();
    expect(harness.messages.filter((message) => message.includes("synthetic failure"))).toEqual([
      "[local] error: synthetic failure",
    ]);
  });

  it("fences a pending approval when shutdown begins", async () => {
    const harness = createShellHarness();
    const run = harness.runLocalShellLine("!echo late");
    const selector = harness.getLastSelector();

    await harness.shutdown();
    selector?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    expect(harness.supervisor.spawn).not.toHaveBeenCalled();
    expect(harness.supervisor.cancelScope).toHaveBeenCalledOnce();
    expect(harness.supervisor.waitForScope).toHaveBeenCalledWith(
      vi.mocked(harness.supervisor.cancelScope).mock.calls[0]?.[0],
    );
    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandle);
  });

  it("keeps another TUI instance's settled command scope alive during shutdown", async () => {
    const spawn = createSettlingSpawn({});
    const first = createShellHarness({ spawn });
    const second = createShellHarness({ supervisor: first.supervisor });

    for (const harness of [first, second]) {
      const run = harness.runLocalShellLine("!echo alive");
      harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
      await run;
    }

    const firstScope = spawn.mock.calls[0]?.[0].scopeKey;
    const secondScope = spawn.mock.calls[1]?.[0].scopeKey;
    expect(firstScope).toBeDefined();
    expect(secondScope).toBeDefined();
    expect(firstScope).not.toBe(secondScope);
    const liveScopes = new Set([firstScope, secondScope]);
    vi.mocked(first.supervisor.cancelScope).mockImplementation((scopeKey) => {
      liveScopes.delete(scopeKey);
    });

    const shutdown = first.shutdown();
    expect(first.shutdown()).toBe(shutdown);
    await shutdown;

    expect(first.supervisor.cancelScope).toHaveBeenCalledOnce();
    expect(first.supervisor.cancelScope).toHaveBeenCalledWith(firstScope);
    expect(first.supervisor.waitForScope).toHaveBeenCalledWith(firstScope);
    expect(liveScopes).toEqual(new Set([secondScope]));
  });
});
