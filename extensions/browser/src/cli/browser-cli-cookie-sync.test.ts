import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import * as parentCoreApiModule from "../core-api.js";
import * as cliCoreApiModule from "./core-api.js";

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({ ok: true, targetId: "tab-1", added: 1 })),
}));

const systemProfileMocks = vi.hoisted(() => ({
  readSystemProfileCookies: vi.fn(async () => ({
    browser: "chrome" as const,
    systemProfile: "Default",
    cookies: [
      {
        name: "session",
        value: "cookie-secret",
        domain: ".example.com",
        path: "/",
        httpOnly: true,
        secure: true,
      },
    ],
    counts: { total: 2, imported: 1, failed: 0, skipped: 1 },
    domains: [".example.com"],
  })),
}));

vi.mock("../sdk-node-runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("../sdk-node-runtime.js")>("../sdk-node-runtime.js");
  return { ...actual, callGatewayFromCli: gatewayMocks.callGatewayFromCli };
});

vi.mock("../system-profile-api.js", () => ({
  assertSystemCookiePlatform: vi.fn(),
  readSystemProfileCookies: systemProfileMocks.readSystemProfileCookies,
  resolveSystemCookieSource: vi.fn(),
}));

vi.spyOn(parentCoreApiModule, "runCommandWithRuntime").mockImplementation(
  async (_runtime, action, onError) => {
    try {
      await action();
    } catch (error) {
      onError?.(error);
    }
  },
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(runtime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(runtime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(runtime.exit);

let registerBrowserCookieSyncCommand: typeof import("./browser-cli-cookie-sync.js").registerBrowserCookieSyncCommand;

function createProgram() {
  const program = new Command();
  const browser = program
    .command("browser")
    .option("--url <url>", "Gateway URL")
    .option("--token <token>", "Gateway token")
    .option("--timeout <ms>", "Timeout", "30000");
  registerBrowserCookieSyncCommand(browser, (command) => command.optsWithGlobals());
  return program;
}

describe("browser cookie-sync CLI", () => {
  beforeAll(async () => {
    ({ registerBrowserCookieSyncCommand } = await import("./browser-cli-cookie-sync.js"));
  });

  beforeEach(() => {
    resetRuntimeCapture();
    gatewayMocks.callGatewayFromCli.mockClear();
    systemProfileMocks.readSystemProfileCookies.mockClear();
  });

  it("requires a non-empty domain allowlist before any read or gateway call", async () => {
    await expect(
      createProgram().parseAsync(["browser", "cookie-sync"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("--domains is required");
    expect(systemProfileMocks.readSystemProfileCookies).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("reads allowlisted cookies locally and posts them through browser.request", async () => {
    await createProgram().parseAsync(
      [
        "browser",
        "--url",
        "wss://gateway.example",
        "--token",
        "test-token",
        "cookie-sync",
        "--domains",
        "example.com, accounts.example.com",
        "--into",
        "work",
        "--browser",
        "chrome",
        "--system",
        "Profile 1",
      ],
      { from: "user" },
    );

    expect(systemProfileMocks.readSystemProfileCookies).toHaveBeenCalledWith(
      {
        browser: "chrome",
        systemProfile: "Profile 1",
        domains: ["example.com", "accounts.example.com"],
        signal: undefined,
      },
      { readSecret: undefined },
    );
    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ url: "wss://gateway.example", token: "test-token" }),
      {
        method: "POST",
        path: "/cookies/set-many",
        query: { profile: "work" },
        body: {
          cookies: [expect.objectContaining({ name: "session", domain: ".example.com" })],
        },
        timeoutMs: 30_000,
      },
      { progress: undefined, scopes: ["operator.admin"] },
    );
    expect(runtime.log.mock.calls.at(-1)?.[0]).toContain(
      "chrome/Default -> work via wss://gateway.example",
    );
    expect(runtime.log.mock.calls.at(-1)?.[0]).not.toContain("cookie-secret");
  });
});
