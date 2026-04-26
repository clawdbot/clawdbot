import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserManageProgram,
  getBrowserManageCallBrowserRequestMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntime, getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

describe("browser manage output", () => {
  beforeEach(() => {
    getBrowserManageCallBrowserRequestMock().mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("shows chrome-mcp transport for existing-session status without fake CDP fields", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "chrome-live",
            driver: "existing-session",
            transport: "chrome-mcp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: 4321,
            cdpPort: null,
            cdpUrl: null,
            chosenBrowser: null,
            userDataDir: null,
            color: "#00AA00",
            headless: false,
            headlessSource: "default",
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome-live", "status"], {
      from: "user",
    });

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("transport: chrome-mcp");
    expect(output).toContain("headless: false (default)");
    expect(output).not.toContain("cdpPort:");
    expect(output).not.toContain("cdpUrl:");
  });

  it("shows configured userDataDir for existing-session status", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "brave-live",
            driver: "existing-session",
            transport: "chrome-mcp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: 4321,
            cdpPort: null,
            cdpUrl: null,
            chosenBrowser: null,
            userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
            color: "#FB542B",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "brave-live", "status"], {
      from: "user",
    });

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain(
      "userDataDir: /Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
    );
  });

  it("shows chrome-mcp transport in browser profiles output", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/profiles"
        ? {
            profiles: [
              {
                name: "chrome-live",
                driver: "existing-session",
                transport: "chrome-mcp",
                running: true,
                tabCount: 2,
                isDefault: false,
                isRemote: false,
                cdpPort: null,
                cdpUrl: null,
                color: "#00AA00",
              },
            ],
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "profiles"], { from: "user" });

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("chrome-live: running (2 tabs) [existing-session]");
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("shows chrome-mcp transport after creating an existing-session profile", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/profiles/create"
        ? {
            ok: true,
            profile: "chrome-live",
            transport: "chrome-mcp",
            cdpPort: null,
            cdpUrl: null,
            userDataDir: null,
            color: "#00AA00",
            isRemote: false,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(
      ["browser", "create-profile", "--name", "chrome-live", "--driver", "existing-session"],
      { from: "user" },
    );

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Created profile "chrome-live"');
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("redacts sensitive remote cdpUrl details in status output", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "remote",
            driver: "openclaw",
            transport: "cdp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: null,
            cdpPort: 9222,
            cdpUrl:
              "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
            chosenBrowser: null,
            userDataDir: null,
            color: "#00AA00",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "remote", "status"], {
      from: "user",
    });

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("prints a readable browser doctor report", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/") {
        return {
          enabled: true,
          profile: "openclaw",
          driver: "openclaw",
          transport: "cdp",
          running: true,
          cdpReady: true,
          cdpHttp: true,
          pid: 4321,
          cdpPort: 18792,
          cdpUrl: "http://127.0.0.1:18792",
          chosenBrowser: "chrome",
          userDataDir: null,
          color: "#00AA00",
          headless: false,
          noSandbox: false,
          executablePath: null,
          attachOnly: false,
        };
      }
      if (req.path === "/profiles") {
        return { profiles: [{ name: "openclaw", running: true }] };
      }
      if (req.path === "/tabs") {
        return {
          running: true,
          tabs: [
            {
              targetId: "abc",
              tabId: "t1",
              suggestedTargetId: "t1",
              title: "Example",
              url: "https://example.com",
            },
          ],
        };
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "doctor"], { from: "user" });

    const output = getBrowserCliRuntime().log.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("OK gateway: browser control endpoint reachable");
    expect(output).toContain("OK tabs: 1 visible, use target t1");
  });
});
