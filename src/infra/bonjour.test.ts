import os from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as logging from "../logging.js";

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  shutdown: vi.fn(),
  registerUnhandledRejectionHandler: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
const { createService, shutdown, registerUnhandledRejectionHandler, logWarn, logDebug } = mocks;

const asString = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value : fallback;

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return {
    ...actual,
    logWarn: (message: string) => logWarn(message),
    logDebug: (message: string) => logDebug(message),
    logInfo: vi.fn(),
    logError: vi.fn(),
    logSuccess: vi.fn(),
  };
});

vi.mock("@homebridge/ciao", () => {
  return {
    Protocol: { TCP: "tcp" },
    getResponder: () => ({
      createService,
      shutdown,
    }),
  };
});

vi.mock("./unhandled-rejections.js", () => {
  return {
    registerUnhandledRejectionHandler: (handler: (reason: unknown) => boolean) =>
      registerUnhandledRejectionHandler(handler),
  };
});

const { startGatewayBonjourAdvertiser } = await import("./bonjour.js");

describe("gateway bonjour advertiser", () => {
  type ServiceCall = {
    name?: unknown;
    hostname?: unknown;
    domain?: unknown;
    txt?: unknown;
  };

  const prevEnv = { ...process.env };

  beforeEach(() => {
    vi.spyOn(logging, "getLogger").mockReturnValue({
      info: (...args: unknown[]) => getLoggerInfo(...args),
    });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(prevEnv)) {
      process.env[key] = value;
    }

    createService.mockReset();
    shutdown.mockReset();
    registerUnhandledRejectionHandler.mockReset();
    logWarn.mockReset();
    logDebug.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not block on advertise and publishes expected txt keys", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("test-host");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        }),
    );

    createService.mockImplementation((options: Record<string, unknown>) => {
      return {
        advertise,
        destroy,
        serviceState: "announced",
        on: vi.fn(),
        getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
        getHostname: () => asString(options.hostname, "unknown"),
        getPort: () => Number(options.port ?? -1),
      };
    });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
      tailnetDns: "host.tailnet.ts.net",
      cliPath: "/opt/homebrew/bin/moltbot",
    });

    expect(createService).toHaveBeenCalledTimes(1);
    const [gatewayCall] = createService.mock.calls as Array<[Record<string, unknown>]>;
    expect(gatewayCall?.[0]?.type).toBe("moltbot-gw");
    const gatewayType = asString(gatewayCall?.[0]?.type, "");
    expect(gatewayType.length).toBeLessThanOrEqual(15);
    expect(gatewayCall?.[0]?.port).toBe(18789);
    expect(gatewayCall?.[0]?.domain).toBe("local");
    expect(gatewayCall?.[0]?.hostname).toBe("test-host");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("test-host.local");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.gatewayPort).toBe("18789");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.sshPort).toBe("2222");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.cliPath).toBe(
      "/opt/homebrew/bin/moltbot",
    );
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.transport).toBe("gateway");

    // We don't await `advertise()`, but it should still be called for each service.
    expect(advertise).toHaveBeenCalledTimes(1);

    await started.stop();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("omits cliPath and sshPort in minimal mode", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("test-host");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);

    createService.mockImplementation((options: Record<string, unknown>) => {
      return {
        advertise,
        destroy,
        serviceState: "announced",
        on: vi.fn(),
        getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
        getHostname: () => asString(options.hostname, "unknown"),
        getPort: () => Number(options.port ?? -1),
      };
    });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
      cliPath: "/opt/homebrew/bin/moltbot",
      minimal: true,
    });

    const [gatewayCall] = createService.mock.calls as Array<[Record<string, unknown>]>;
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.sshPort).toBeUndefined();
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.cliPath).toBeUndefined();

    await started.stop();
  });

  it("attaches conflict listeners for services", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("test-host");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    const onCalls: Array<{ event: string }> = [];

    createService.mockImplementation((options: Record<string, unknown>) => {
      const on = vi.fn((event: string) => {
        onCalls.push({ event });
      });
      return {
        advertise,
        destroy,
        serviceState: "announced",
        on,
        getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
        getHostname: () => asString(options.hostname, "unknown"),
        getPort: () => Number(options.port ?? -1),
      };
    });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    // 1 service × 2 listeners
    expect(onCalls.map((c) => c.event)).toEqual(["name-change", "hostname-change"]);

    await started.stop();
  });

  it("cleans up unhandled rejection handler after shutdown", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("test-host");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    const order: string[] = [];
    shutdown.mockImplementation(async () => {
      order.push("shutdown");
    });

    createService.mockImplementation((options: Record<string, unknown>) => {
      return {
        advertise,
        destroy,
        serviceState: "announced",
        on: vi.fn(),
        getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
        getHostname: () => asString(options.hostname, "unknown"),
        getPort: () => Number(options.port ?? -1),
      };
    });

    const cleanup = vi.fn(() => {
      order.push("cleanup");
    });
    registerUnhandledRejectionHandler.mockImplementation(() => cleanup);

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    await started.stop();

    expect(registerUnhandledRejectionHandler).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["shutdown", "cleanup"]);
  });

  it("logs advertise failures and retries via watchdog", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.useFakeTimers();
    vi.spyOn(os, "hostname").mockReturnValue("test-host");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom")) // initial advertise fails
      .mockResolvedValue(undefined); // watchdog retry succeeds

    createService.mockImplementation((options: Record<string, unknown>) => {
      return {
        advertise,
        destroy,
        serviceState: "unannounced",
        on: vi.fn(),
        getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
        getHostname: () => asString(options.hostname, "unknown"),
        getPort: () => Number(options.port ?? -1),
      };
    });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    // initial advertise attempt happens immediately
    expect(advertise).toHaveBeenCalledTimes(1);

    // allow promise rejection handler to run
    await Promise.resolve();
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("advertise failed"));

    // watchdog should attempt re-advertise at the 60s interval tick
    await vi.advanceTimersByTimeAsync(60_000);
    expect(advertise).toHaveBeenCalledTimes(2);

    await started.stop();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(advertise).toHaveBeenCalledTimes(2);
  });

  it("handles advertise throwing synchronously", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("test-host");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn(() => {
      throw new Error("sync-fail");
    });

    createService.mockImplementation((options: Record<string, unknown>) => {
      return {
        advertise,
        destroy,
        serviceState: "unannounced",
        on: vi.fn(),
        getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
        getHostname: () => asString(options.hostname, "unknown"),
        getPort: () => Number(options.port ?? -1),
      };
    });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(advertise).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("advertise threw"));

    await started.stop();
  });

  it("normalizes hostnames with domains for service names", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("Mac.localdomain");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    createService.mockImplementation((options: Record<string, unknown>) => {
      return {
        advertise,
        destroy,
        serviceState: "announced",
        on: vi.fn(),
        getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
        getHostname: () => asString(options.hostname, "unknown"),
        getPort: () => Number(options.port ?? -1),
      };
    });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    expect(gatewayCall?.[0]?.name).toBe("Mac (Moltbot)");
    expect(gatewayCall?.[0]?.domain).toBe("local");
    expect(gatewayCall?.[0]?.hostname).toBe("Mac");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("Mac.local");

    await started.stop();
  });
});
