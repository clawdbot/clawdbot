import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkConfiguredCodexAppAvailability } from "./configured-app-availability.js";

describe("configured Codex app availability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns once when a required app is not installed or authorized", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async () => ({
      apps: [{ id: "github", enabled: true, callable: true }],
    }));
    const params = {
      client: { request } as never,
      appCacheKey: "account-a",
      requiredAppIds: ["slack"],
      timeoutMs: 1_000,
    };

    await checkConfiguredCodexAppAvailability(params);
    await checkConfiguredCodexAppAvailability(params);

    expect(request.mock.calls.map(([method]) => method)).toEqual(["app/installed"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "required Codex app is unavailable; install or authorize it to expose its tools",
      { appId: "slack", state: "not_installed_or_authorized" },
    );
  });

  it("does not warn when every required app is installed", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async () => ({
      apps: [{ id: "slack", enabled: true, callable: true }],
    }));

    await checkConfiguredCodexAppAvailability({
      client: { request } as never,
      appCacheKey: "account-b",
      requiredAppIds: ["slack"],
      timeoutMs: 1_000,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("skips app inventory when no app is required", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const request = vi.fn();

    await checkConfiguredCodexAppAvailability({
      client: { request } as never,
      appCacheKey: "account-c",
      requiredAppIds: [],
      timeoutMs: 1_000,
    });

    expect(request).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
