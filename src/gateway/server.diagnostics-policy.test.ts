import { expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { logWebhookReceived } from "../logging/diagnostic.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";

it("owns diagnostic dispatch and heartbeat across initial disable, enable, disable, and close", async () => {
  const previouslyEnabled = areDiagnosticsEnabledForProcess();
  const state = await createOpenClawTestState({
    label: "gateway-diagnostics-policy",
    env: {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const port = await getFreePort();
    await state.writeConfig({
      diagnostics: { enabled: false },
      gateway: { mode: "local", port, auth: { mode: "none" }, controlUi: { enabled: false } },
    });
    state.applyEnv();
    kernel = await createGatewayKernel(port, {
      auth: { mode: "none" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    expect(areDiagnosticsEnabledForProcess()).toBe(false);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const events: string[] = [];
    unsubscribe = onDiagnosticEvent((event) => events.push(event.type));
    const tick = async () => {
      logWebhookReceived({ channel: "test" });
      await vi.advanceTimersByTimeAsync(30_000);
      await waitForDiagnosticEventsDrained();
    };
    await tick();
    expect(events).toEqual([]);

    kernel.configureDiagnostics({ diagnostics: { enabled: true } });
    await tick();
    expect(events.filter((event) => event === "webhook.received")).toHaveLength(1);
    expect(events.filter((event) => event === "diagnostic.heartbeat")).toHaveLength(1);

    kernel.configureDiagnostics({ diagnostics: { enabled: false } });
    await tick();
    expect(events.filter((event) => event === "webhook.received")).toHaveLength(1);
    expect(events.filter((event) => event === "diagnostic.heartbeat")).toHaveLength(1);

    kernel.configureDiagnostics({});
    await tick();
    expect(events.filter((event) => event === "diagnostic.heartbeat")).toHaveLength(2);
    await kernel.closeOnStartupFailure();
    kernel.configureDiagnostics({ diagnostics: { enabled: true } });
    await tick();
    expect(events.filter((event) => event === "diagnostic.heartbeat")).toHaveLength(2);
  } finally {
    unsubscribe?.();
    await kernel?.closeOnStartupFailure();
    vi.useRealTimers();
    await state.cleanup();
    setDiagnosticsEnabledForProcess(previouslyEnabled);
  }
}, 60_000);
