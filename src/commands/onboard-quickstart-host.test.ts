import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "../wizard/i18n/index.js";
import { runQuickstartForegroundGateway } from "./onboard-quickstart-host.js";

type HostDeps = NonNullable<Parameters<typeof runQuickstartForegroundGateway>[1]>;

function createHostHarness(config: OpenClawConfig = { gateway: { auth: { mode: "none" } } }) {
  const events: string[] = [];
  const gateway = createDeferred();
  const readiness = createDeferred<{ ok: boolean }>();
  const probing = createDeferred();
  const summary = createDeferred();
  const runtime: RuntimeEnv = {
    log: vi.fn((message) => {
      if (message === t("wizard.guided.quickstartReopen")) {
        summary.resolve();
      }
    }),
    error: vi.fn(),
    exit: vi.fn(),
  };
  const deps = {
    readConfigSnapshot: vi.fn(async () => ({ config })),
    runGateway: vi.fn<NonNullable<HostDeps["runGateway"]>>(() => {
      events.push("gateway started");
      return gateway.promise;
    }),
    waitForGateway: vi.fn<NonNullable<HostDeps["waitForGateway"]>>(() => {
      events.push("readiness probe");
      probing.resolve();
      return readiness.promise;
    }),
    runBrowserHandoff: vi.fn<NonNullable<HostDeps["runBrowserHandoff"]>>(async () => {
      events.push("browser handoff");
      return { handedOff: true };
    }),
  } satisfies HostDeps;
  return { config, events, gateway, readiness, probing, summary, runtime, deps };
}

describe("runQuickstartForegroundGateway", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
    vi.stubEnv("OPENCLAW_LOCALE", "en");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["token", "password"] as const)(
    "starts the Gateway and verifies %s auth before opening the dashboard",
    async (mode) => {
      const h = createHostHarness({
        gateway: {
          mode: "local",
          bind: "loopback",
          port: 19431,
          auth: { mode, token: "synthetic-token", password: "synthetic-password" },
          controlUi: { basePath: "/dashboard" },
        },
      });
      const host = runQuickstartForegroundGateway({ runtime: h.runtime }, h.deps);
      await h.probing.promise;

      expect(h.events).toEqual(["gateway started", "readiness probe"]);
      expect(h.deps.runBrowserHandoff).not.toHaveBeenCalled();
      expect(h.deps.waitForGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "ws://127.0.0.1:19431/dashboard",
          token: mode === "token" ? "synthetic-token" : undefined,
          password: mode === "password" ? "synthetic-password" : undefined,
        }),
      );

      h.readiness.resolve({ ok: true });
      await h.summary.promise;
      expect(h.events).toEqual(["gateway started", "readiness probe", "browser handoff"]);
      expect(h.deps.runBrowserHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ config: h.config }),
      );
      expect(h.runtime.log).toHaveBeenCalledWith("Dashboard: http://127.0.0.1:19431/dashboard/");
      expect(h.runtime.log).toHaveBeenCalledWith(expect.stringContaining("Ctrl+C"));
      expect(h.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("openclaw gateway install"),
      );
      expect(h.runtime.log).toHaveBeenCalledWith(expect.stringContaining("openclaw dashboard"));

      h.gateway.resolve();
      await host;
      expect(h.runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("surfaces startup failure without waiting for the readiness timeout", async () => {
    const h = createHostHarness();
    const host = runQuickstartForegroundGateway({ runtime: h.runtime }, h.deps);
    const failed = expect(host).rejects.toThrow("startup failed");
    await h.probing.promise;
    h.gateway.reject(new Error("startup failed"));

    await failed;
    expect(h.deps.runBrowserHandoff).not.toHaveBeenCalled();
  });

  it.each(["timeout", "error"] as const)(
    "keeps owning the Gateway after a browser handoff %s",
    async (failure) => {
      const h = createHostHarness();
      h.deps.runBrowserHandoff.mockImplementation(async () => {
        if (failure === "error") {
          throw new Error("browser unavailable");
        }
        return { handedOff: false, reason: "timeout" };
      });
      const host = runQuickstartForegroundGateway({ runtime: h.runtime }, h.deps);
      const stopped = expect(host).rejects.toThrow("later Gateway failure");
      await h.probing.promise;
      h.readiness.resolve({ ok: true });
      await h.summary.promise;

      expect(h.runtime.log).toHaveBeenCalledWith(t("wizard.guided.quickstartBrowserUnavailable"));
      expect(h.runtime.exit).not.toHaveBeenCalled();
      h.gateway.reject(new Error("later Gateway failure"));
      await stopped;
    },
  );

  it("surfaces Gateway failure while browser handoff is still pending", async () => {
    const h = createHostHarness();
    const handoffStarted = createDeferred();
    const handoff = createDeferred<{ handedOff: true }>();
    h.deps.runBrowserHandoff.mockImplementation(() => {
      handoffStarted.resolve();
      return handoff.promise;
    });
    const host = runQuickstartForegroundGateway({ runtime: h.runtime }, h.deps);
    const stopped = expect(host).rejects.toThrow("Gateway failed during handoff");
    await h.probing.promise;
    h.readiness.resolve({ ok: true });
    await handoffStarted.promise;
    h.gateway.reject(new Error("Gateway failed during handoff"));

    await stopped;
    expect(h.runtime.log).not.toHaveBeenCalledWith(t("wizard.guided.quickstartBrowserUnavailable"));
    handoff.resolve({ handedOff: true });
  });

  it("keeps the foreground Gateway alive when readiness is not confirmed", async () => {
    const h = createHostHarness();
    const host = runQuickstartForegroundGateway({ runtime: h.runtime }, h.deps);
    const stopped = expect(host).rejects.toThrow("later Gateway failure");
    await h.probing.promise;
    h.readiness.resolve({ ok: false });
    await h.summary.promise;

    expect(h.deps.runBrowserHandoff).not.toHaveBeenCalled();
    expect(h.runtime.log).toHaveBeenCalledWith(t("wizard.guided.quickstartGatewayPending"));
    h.gateway.reject(new Error("later Gateway failure"));
    await stopped;
  });
});
