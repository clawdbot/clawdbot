import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
export const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
export const { handleDiscordMessageAction } = await import("./handle-action.js");

export function discordConfig(actions?: Record<string, boolean>): OpenClawConfig {
  return {
    channels: { discord: { token: "tok", ...(actions ? { actions } : {}) } },
  } as OpenClawConfig;
}

export function defaultActionOptions() {
  return {
    mediaAccess: undefined,
    mediaLocalRoots: undefined,
    mediaReadFile: undefined,
  };
}

export function expectDiscordActionCall(params: {
  payload: unknown;
  cfg: OpenClawConfig;
  options?: unknown;
}) {
  expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
  const [call] = handleDiscordActionMock.mock.calls;
  if (!call) {
    throw new Error("expected Discord action call");
  }
  const [payload, cfg, options] = call;
  expect(payload).toEqual(params.payload);
  expect(cfg).toBe(params.cfg);
  if ("options" in params) {
    expect(options).toEqual(params.options);
  } else {
    expect(options).toBeUndefined();
  }
}
