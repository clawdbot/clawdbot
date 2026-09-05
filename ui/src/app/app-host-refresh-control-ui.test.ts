/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { retryStaleChunkReloadWhenReachable } from "./stale-chunk-reload.ts";

type RetryOptions = Parameters<typeof retryStaleChunkReloadWhenReachable>[0];

const retryHarness = vi.hoisted(() => ({
  retry: vi.fn<(options: RetryOptions) => Promise<boolean>>(),
}));

vi.mock("./stale-chunk-reload.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stale-chunk-reload.ts")>();
  return {
    ...actual,
    retryStaleChunkReloadWhenReachable: retryHarness.retry,
  };
});

import "./app-host.ts";

type RefreshShell = HTMLElement & {
  runtime: ApplicationRuntime;
  refreshControlUi: () => Promise<boolean>;
};

function deferred() {
  let resolve: (value: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createRefreshShell() {
  const snapshot = { controlUiRefreshRequired: true };
  const shell = document.createElement("openclaw-app-shell") as RefreshShell;
  shell.runtime = {
    context: { overlays: { snapshot } },
  } as unknown as ApplicationRuntime;
  return { shell, snapshot };
}

function installRetryProbe() {
  const probe = deferred();
  const reload = vi.fn();
  retryHarness.retry.mockImplementation(async (options) => {
    const reachable = await probe.promise;
    if (!reachable || options?.canReload?.() === false) {
      return false;
    }
    reload();
    return true;
  });
  return { probe, reload };
}

afterEach(() => {
  retryHarness.retry.mockReset();
  document.body.replaceChildren();
});

describe("OpenClaw shell Control UI refresh", () => {
  it("does not reload after the recovery state clears during a successful probe", async () => {
    const { probe, reload } = installRetryProbe();
    const { shell, snapshot } = createRefreshShell();

    const refresh = shell.refreshControlUi();
    snapshot.controlUiRefreshRequired = false;
    probe.resolve(true);

    await expect(refresh).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("allows a successful reload while the same recovery state is still current", async () => {
    const { probe, reload } = installRetryProbe();
    const { shell } = createRefreshShell();

    const refresh = shell.refreshControlUi();
    probe.resolve(true);

    await expect(refresh).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});
