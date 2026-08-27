// Slack tests cover index plugin behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import "./index.js";
import setupEntry from "./setup-entry.js";

const httpRegistryMocks = vi.hoisted(() => ({
  handleSlackHttpRequest: vi.fn(async () => true),
}));
const entryContractMocks = vi.hoisted(() => ({
  registerFull: undefined as ((api: OpenClawPluginApi) => void) | undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-entry-contract", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-entry-contract")>();
  return {
    ...actual,
    defineBundledChannelEntry: (
      options: Parameters<typeof actual.defineBundledChannelEntry>[0],
    ) => {
      entryContractMocks.registerFull = options.registerFull;
      return actual.defineBundledChannelEntry(options);
    },
  };
});

vi.mock("./src/http/registry.js", () => ({
  handleSlackHttpRequest: httpRegistryMocks.handleSlackHttpRequest,
}));

describe("slack bundled entries", () => {
  it("does not register webhook routes during tool discovery", () => {
    const registerHttpRoute = vi.fn();
    entryContractMocks.registerFull?.(
      createTestPluginApi({
        id: "slack",
        registrationMode: "tool-discovery",
        config: {
          channels: {
            slack: {
              webhookPath: "/slack/root",
            },
          },
        },
        registerHttpRoute,
      }),
    );

    expect(registerHttpRoute).not.toHaveBeenCalled();
  });

  it("registers each webhook route once during full registration", async () => {
    const registerHttpRoute = vi.fn();
    entryContractMocks.registerFull?.(
      createTestPluginApi({
        id: "slack",
        registrationMode: "full",
        config: {
          channels: {
            slack: {
              webhookPath: "/slack/root",
              accounts: {
                default: { webhookPath: "/slack/default" },
                ops: { webhookPath: "hooks/ops" },
              },
            },
          },
        },
        registerHttpRoute,
      }),
    );

    expect(registerHttpRoute.mock.calls.map((call) => call[0].path)).toEqual([
      "/hooks/ops",
      "/slack/default",
    ]);
    expect(registerHttpRoute).toHaveBeenCalledTimes(2);
    expect(httpRegistryMocks.handleSlackHttpRequest).not.toHaveBeenCalled();

    const handler = registerHttpRoute.mock.calls[0]?.[0].handler;
    await handler?.({ url: "/hooks/ops" }, {});
    expect(httpRegistryMocks.handleSlackHttpRequest).toHaveBeenCalledOnce();
  });

  it("uses the root Slack webhook path when the default account does not override it", () => {
    const registerHttpRoute = vi.fn();
    entryContractMocks.registerFull?.(
      createTestPluginApi({
        id: "slack",
        registrationMode: "full",
        config: {
          channels: {
            slack: {
              webhookPath: "/slack/root",
              accounts: {
                ops: { webhookPath: "hooks/ops" },
              },
            },
          },
        },
        registerHttpRoute,
      }),
    );

    expect(registerHttpRoute.mock.calls.map((call) => call[0].path)).toEqual([
      "/hooks/ops",
      "/slack/root",
    ]);
  });

  it("leaves webhook route ownership to the full channel entry", () => {
    expect("registerSetupRuntime" in setupEntry).toBe(false);
  });
});
