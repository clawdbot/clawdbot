import { expect } from "vitest";

type MockFn = (...args: never[]) => unknown;

type CfgThreadingAssertion<TCfg> = {
  loadConfig: MockFn;
  resolveAccount: MockFn;
  cfg: TCfg;
  accountId?: string;
};

type SendRuntimeState = {
  loadConfig: MockFn;
  resolveMarkdownTableMode: MockFn;
  convertMarkdownTables: MockFn;
  record: MockFn;
};

export function expectProvidedCfgSkipsRuntimeLoad<TCfg>({
  loadConfig,
  resolveAccount,
  cfg,
  accountId,
}: CfgThreadingAssertion<TCfg>): void {
  expect(loadConfig).not.toHaveBeenCalled();
  expect(resolveAccount).toHaveBeenCalledWith({
    cfg,
    accountId,
  });
}

export function expectRuntimeCfgFallback<TCfg>({
  loadConfig,
  resolveAccount,
  cfg,
  accountId,
}: CfgThreadingAssertion<TCfg>): void {
  expect(loadConfig).toHaveBeenCalledTimes(1);
  expect(resolveAccount).toHaveBeenCalledWith({
    cfg,
    accountId,
  });
}

export function createSendCfgThreadingRuntime({
  loadConfig,
  resolveMarkdownTableMode,
  convertMarkdownTables,
  record,
}: SendRuntimeState) {
  return {
    config: {
      loadConfig,
    },
    channel: {
      text: {
        resolveMarkdownTableMode,
        convertMarkdownTables,
      },
      activity: {
        record,
      },
    },
  };
}
