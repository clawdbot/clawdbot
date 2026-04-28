import { expect, vi } from "vitest";
import type { ChannelAccountSnapshot, ChannelGatewayContext } from "../testing.js";
import { createStartAccountContext } from "./start-account-context.js";

export function startAccountAndTrackLifecycle<TAccount extends { accountId: string }>(params: {
  startAccount: (ctx: ChannelGatewayContext<TAccount>) => Promise<unknown>;
  account: TAccount;
}) {
  const patches: ChannelAccountSnapshot[] = [];
  const abort = new AbortController();
  const task = params.startAccount(
    createStartAccountContext({
      account: params.account,
      abortSignal: abort.signal,
      statusPatchSink: (next) => patches.push({ ...next }),
    }),
  );
  let settled = false;
  void task.then(() => {
    settled = true;
  });
  return {
    abort,
    patches,
    task,
    isSettled: () => settled,
  };
}

export async function abortStartedAccount(params: {
  abort: AbortController;
  task: Promise<unknown>;
}) {
  params.abort.abort();
  await params.task;
}

export function waitForStartedMocks(...mocks: Array<ReturnType<typeof vi.fn>>) {
  return async () => {
    await vi.waitFor(() => {
      for (const mock of mocks) {
        expect(mock).toHaveBeenCalledOnce();
      }
    });
  };
}

export function expectLifecyclePatch(
  patches: ChannelAccountSnapshot[],
  expected: Partial<ChannelAccountSnapshot>,
) {
  expect(patches).toContainEqual(expect.objectContaining(expected));
}

export async function expectPendingUntilAbort(params: {
  waitForStarted: () => Promise<void>;
  isSettled: () => boolean;
  abort: AbortController;
  task: Promise<unknown>;
  assertBeforeAbort?: () => void;
  assertAfterAbort?: () => void;
}) {
  await params.waitForStarted();
  expect(params.isSettled()).toBe(false);
  params.assertBeforeAbort?.();
  await abortStartedAccount({ abort: params.abort, task: params.task });
  params.assertAfterAbort?.();
}

export async function expectStopPendingUntilAbort(params: {
  waitForStarted: () => Promise<void>;
  isSettled: () => boolean;
  abort: AbortController;
  task: Promise<unknown>;
  stop: ReturnType<typeof vi.fn>;
}) {
  await expectPendingUntilAbort({
    waitForStarted: params.waitForStarted,
    isSettled: params.isSettled,
    abort: params.abort,
    task: params.task,
    assertBeforeAbort: () => {
      expect(params.stop).not.toHaveBeenCalled();
    },
    assertAfterAbort: () => {
      expect(params.stop).toHaveBeenCalledOnce();
    },
  });
}
