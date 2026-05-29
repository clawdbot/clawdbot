import { assertBundledChannelEntries } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

const httpRegistryMocks = vi.hoisted(() => ({
  handleSlackHttpRequest: vi.fn(async () => true),
}));

vi.mock("./src/http/registry.js", () => ({
  handleSlackHttpRequest: httpRegistryMocks.handleSlackHttpRequest,
}));

describe("slack bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "slack",
    expectedName: "Slack",
    setupEntry,
  });

  it("registers webhook routes through the full channel entry", async () => {
    const registerHttpRoute = vi.fn();
    entry.register({
      registrationMode: "tool-discovery",
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
    } as never);

    expect(registerHttpRoute.mock.calls.map((call) => call[0].path)).toEqual([
      "/hooks/ops",
      "/slack/default",
    ]);
    expect(httpRegistryMocks.handleSlackHttpRequest).not.toHaveBeenCalled();

    const handler = registerHttpRoute.mock.calls[0]?.[0].handler;
    await handler?.({ url: "/hooks/ops" }, {});
    expect(httpRegistryMocks.handleSlackHttpRequest).toHaveBeenCalledOnce();
  });

  it("uses the root Slack webhook path when the default account does not override it", () => {
    const registerHttpRoute = vi.fn();
    entry.register({
      registrationMode: "tool-discovery",
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
    } as never);

    expect(registerHttpRoute.mock.calls.map((call) => call[0].path)).toEqual([
      "/hooks/ops",
      "/slack/root",
    ]);
  });

  it("registers webhook routes through the setup-runtime entry", () => {
    const registerHttpRoute = vi.fn();
    setupEntry.registerSetupRuntime?.({
      registrationMode: "setup-runtime",
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
    } as never);

    expect(registerHttpRoute.mock.calls.map((call) => call[0].path)).toEqual([
      "/hooks/ops",
      "/slack/default",
    ]);
  });
});
