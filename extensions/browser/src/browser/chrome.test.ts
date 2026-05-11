import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import {
  parseBrowserMajorVersion,
  resolveGoogleChromeExecutableForPlatform,
} from "./chrome.executables.js";
import {
  clearStaleChromeSingletonLocks,
  decorateOpenClawProfile,
  diagnoseChromeCdp,
  ensureProfileCleanExit,
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
  formatChromeCdpDiagnostic,
  buildOpenClawChromeLaunchArgs,
  getChromeWebSocketUrl,
  isProfileDecorated,
  isChromeCdpReady,
  isChromeReachable,
  resolveBrowserExecutableForPlatform,
  stopOpenClawChrome,
} from "./chrome.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";

type StopChromeTarget = Parameters<typeof stopOpenClawChrome>[0];
type ChromeCdpDiagnostic = Awaited<ReturnType<typeof diagnoseChromeCdp>>;

function expectFailedChromeCdpDiagnostic(
  diagnostic: ChromeCdpDiagnostic,
): Extract<ChromeCdpDiagnostic, { ok: false }> {
  if (diagnostic.ok) {
    throw new Error("Expected failed Chrome CDP diagnostic");
  }
  return diagnostic;
}

function expectReadyChromeCdpDiagnostic(
  diagnostic: ChromeCdpDiagnostic,
): Extract<ChromeCdpDiagnostic, { ok: true }> {
  if (!diagnostic.ok) {
    throw new Error("Expected ready Chrome CDP diagnostic");
  }
  return diagnostic;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readDefaultProfileFromLocalState(
  userDataDir: string,
): Promise<Record<string, unknown>> {
  const localState = await readJson(path.join(userDataDir, "Local State"));
  const profile = localState.profile as Record<string, unknown>;
  const infoCache = profile.info_cache as Record<string, unknown>;
  return infoCache.Default as Record<string, unknown>;
}

async function withMockChromeCdpServer(params: {
  wsPath: string;
  onConnection?: (wss: WebSocketServer) => void;
  run: (baseUrl: string) => Promise<void>;
}) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/json/version")) {
      const addr = server.address() as AddressInfo;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}${params.wsPath}`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith(params.wsPath)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  params.onConnection?.(wss);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const addr = server.address() as AddressInfo;
    await params.run(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function stopChromeWithProc(proc: ReturnType<typeof makeChromeTestProc>, timeoutMs: number) {
  await stopOpenClawChrome(
    {
      proc,
      cdpPort: 12345,
    } as unknown as StopChromeTarget,
    timeoutMs,
  );
}

function makeChromeTestProc(overrides?: Partial<{ killed: boolean; exitCode: number | null }>) {
  return {
    killed: overrides?.killed ?? false,
    exitCode: overrides?.exitCode ?? null,
    kill: vi.fn(),
  };
}

describe("browser chrome profile decoration", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createUserDataDir = async () => {
    const dir = path.join(fixtureRoot, `profile-${fixtureCount++}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-suite-"));
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fsp.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes expected name + signed ARGB seed to Chrome prefs", async () => {
    const userDataDir = await createUserDataDir();
    decorateOpenClawProfile(userDataDir, { color: DEFAULT_OPENCLAW_BROWSER_COLOR });

    const expectedSignedArgb = ((0xff << 24) | 0xff4500) >> 0;

    const def = await readDefaultProfileFromLocalState(userDataDir);

    expect(def.name).toBe(DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME);
    expect(def.shortcut_name).toBe(DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME);
    expect(def.profile_color_seed).toBe(expectedSignedArgb);
    expect(def.profile_highlight_color).toBe(expectedSignedArgb);
    expect(def.default_avatar_fill_color).toBe(expectedSignedArgb);
    expect(def.default_avatar_stroke_color).toBe(expectedSignedArgb);

    const prefs = await readJson(path.join(userDataDir, "Default", "Preferences"));
    const browser = prefs.browser as Record<string, unknown>;
    const theme = browser.theme as Record<string, unknown>;
    const autogenerated = prefs.autogenerated as Record<string, unknown>;
    const autogeneratedTheme = autogenerated.theme as Record<string, unknown>;

    expect(theme.user_color2).toBe(expectedSignedArgb);
    expect(autogeneratedTheme.color).toBe(expectedSignedArgb);
    expect(prefs.download).toBeUndefined();
    expect(prefs.savefile).toBeUndefined();

    const marker = await fsp.readFile(
      path.join(userDataDir, ".openclaw-profile-decorated"),
      "utf-8",
    );
    expect(marker.trim()).toMatch(/^\d+$/);
  });

  it("writes managed download prefs when a download dir is provided", async () => {
    const userDataDir = await createUserDataDir();
    decorateOpenClawProfile(userDataDir, {
      color: DEFAULT_OPENCLAW_BROWSER_COLOR,
      downloadDir: DEFAULT_DOWNLOAD_DIR,
    });

    const prefs = await readJson(path.join(userDataDir, "Default", "Preferences"));
    const download = prefs.download as Record<string, unknown>;
    const savefile = prefs.savefile as Record<string, unknown>;

    expect(download.default_directory).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(download.prompt_for_download).toBe(false);
    expect(download.directory_upgrade).toBe(true);
    expect(savefile.default_directory).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(
      isProfileDecorated(
        userDataDir,
        DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
        DEFAULT_OPENCLAW_BROWSER_COLOR,
        DEFAULT_DOWNLOAD_DIR,
      ),
    ).toBe(true);
  });

  it("treats missing managed download prefs as undecorated when required", async () => {
    const userDataDir = await createUserDataDir();
    decorateOpenClawProfile(userDataDir, { color: DEFAULT_OPENCLAW_BROWSER_COLOR });

    expect(
      isProfileDecorated(
        userDataDir,
        DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
        DEFAULT_OPENCLAW_BROWSER_COLOR,
        DEFAULT_DOWNLOAD_DIR,
      ),
    ).toBe(false);
  });

  it("best-effort writes name when color is invalid", async () => {
    const userDataDir = await createUserDataDir();
    decorateOpenClawProfile(userDataDir, { color: "lobster-orange" });
    const def = await readDefaultProfileFromLocalState(userDataDir);

    expect(def.name).toBe(DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME);
    expect(def.profile_color_seed).toBeUndefined();
  });

  it("recovers from missing/invalid preference files", async () => {
    const userDataDir = await createUserDataDir();
    await fsp.mkdir(path.join(userDataDir, "Default"), { recursive: true });
    await fsp.writeFile(path.join(userDataDir, "Local State"), "{", "utf-8"); // invalid JSON
    await fsp.writeFile(
      path.join(userDataDir, "Default", "Preferences"),
      "[]", // valid JSON but wrong shape
      "utf-8",
    );

    decorateOpenClawProfile(userDataDir, { color: DEFAULT_OPENCLAW_BROWSER_COLOR });

    const localState = await readJson(path.join(userDataDir, "Local State"));
    expect(typeof localState.profile).toBe("object");

    const prefs = await readJson(path.join(userDataDir, "Default", "Preferences"));
    expect(typeof prefs.profile).toBe("object");
  });

  it("writes clean exit prefs to avoid restore prompts", async () => {
    const userDataDir = await createUserDataDir();
    ensureProfileCleanExit(userDataDir);
    const prefs = await readJson(path.join(userDataDir, "Default", "Preferences"));
    expect(prefs.exit_type).toBe("Normal");
    expect(prefs.exited_cleanly).toBe(true);
  });

  it("is idempotent when rerun on an existing profile", async () => {
    const userDataDir = await createUserDataDir();
    decorateOpenClawProfile(userDataDir, { color: DEFAULT_OPENCLAW_BROWSER_COLOR });
    decorateOpenClawProfile(userDataDir, { color: DEFAULT_OPENCLAW_BROWSER_COLOR });

    const prefs = await readJson(path.join(userDataDir, "Default", "Preferences"));
    const profile = prefs.profile as Record<string, unknown>;
    expect(profile.name).toBe(DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME);
  });

  it("clears stale singleton artifacts when the lock points at another host", async () => {
    const userDataDir = await createUserDataDir();
    await fsp.writeFile(path.join(userDataDir, "SingletonCookie"), "cookie");
    await fsp.writeFile(path.join(userDataDir, "SingletonSocket"), "socket");
    await fsp.symlink("remote-host-535", path.join(userDataDir, "SingletonLock"));

    expect(clearStaleChromeSingletonLocks(userDataDir, "local-host")).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, "SingletonLock"))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, "SingletonSocket"))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, "SingletonCookie"))).toBe(false);
  });

  it("clears stale singleton artifacts when the lock PID is dead on the current host", async () => {
    const userDataDir = await createUserDataDir();
    const deadPid = 2147483646;
    await fsp.symlink(`${os.hostname()}-${deadPid}`, path.join(userDataDir, "SingletonLock"));

    expect(clearStaleChromeSingletonLocks(userDataDir, os.hostname())).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, "SingletonLock"))).toBe(false);
  });

  it("keeps singleton artifacts when the lock points at a current-host live process", async () => {
    const userDataDir = await createUserDataDir();
    await fsp.symlink(`${os.hostname()}-${process.pid}`, path.join(userDataDir, "SingletonLock"));

    expect(clearStaleChromeSingletonLocks(userDataDir, os.hostname())).toBe(false);
    expect(fs.lstatSync(path.join(userDataDir, "SingletonLock")).isSymbolicLink()).toBe(true);
  });

  it("keeps singleton artifacts when the lock PID exists but cannot be signaled", async () => {
    const userDataDir = await createUserDataDir();
    await fsp.symlink(`${os.hostname()}-12345`, path.join(userDataDir, "SingletonLock"));
    const err = new Error("operation not permitted") as NodeJS.ErrnoException;
    err.code = "EPERM";
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
      if (pid === 12345 && signal === 0) {
        throw err;
      }
      return true;
    }) as typeof process.kill);

    try {
      expect(clearStaleChromeSingletonLocks(userDataDir, os.hostname())).toBe(false);
      expect(fs.lstatSync(path.join(userDataDir, "SingletonLock")).isSymbolicLink()).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe("browser chrome helpers", () => {
  function mockExistsSync(match: (pathValue: string) => boolean) {
    return vi.spyOn(fs, "existsSync").mockImplementation((p) => match(String(p)));
  }

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("picks the first existing Chrome candidate on macOS", () => {
    const exists = mockExistsSync((pathValue) =>
      pathValue.includes("Google Chrome.app/Contents/MacOS/Google Chrome"),
    );
    const exe = findChromeExecutableMac();
    expect(exe?.kind).toBe("chrome");
    expect(exe?.path).toMatch(/Google Chrome\.app/);
    exists.mockRestore();
  });

  it("returns null when no Chrome candidate exists", () => {
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(findChromeExecutableMac()).toBeNull();
    exists.mockRestore();
  });

  it("finds common Linux Chromium package paths", () => {
    for (const target of [
      "/usr/lib/chromium/chromium",
      "/usr/lib/chromium-browser/chromium-browser",
    ]) {
      const exists = mockExistsSync((pathValue) => pathValue === target);
      const exe = findChromeExecutableLinux();
      expect(exe).toEqual({ kind: "chromium", path: target });
      exists.mockRestore();
    }
  });

  it("finds common Linux /opt Chrome and Brave paths", () => {
    const cases = [
      { kind: "chrome", path: "/opt/google/chrome/chrome" },
      { kind: "brave", path: "/opt/brave.com/brave/brave-browser" },
    ] as const;

    for (const candidate of cases) {
      const exists = mockExistsSync((pathValue) => pathValue === candidate.path);
      const exe = findChromeExecutableLinux();
      expect(exe).toEqual(candidate);
      exists.mockRestore();
    }
  });

  it("finds Playwright-managed Linux Chromium", () => {
    const browserPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ms-playwright-"));
    const executablePath = path.join(browserPath, "chromium-1217", "chrome-linux64", "chrome");
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", browserPath);
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    const exists = mockExistsSync((pathValue) => pathValue === executablePath);

    try {
      expect(findChromeExecutableLinux()).toEqual({ kind: "chromium", path: executablePath });
    } finally {
      exists.mockRestore();
      fs.rmSync(browserPath, { recursive: true, force: true });
    }
  });

  it("returns null when no Chrome candidate exists on Linux", () => {
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(findChromeExecutableLinux()).toBeNull();
    exists.mockRestore();
  });

  it("picks the first existing Chrome candidate on Windows", () => {
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\Test\\AppData\\Local");
    const exists = mockExistsSync((pathStr) => {
      return (
        pathStr.includes("Google\\Chrome\\Application\\chrome.exe") ||
        pathStr.includes("BraveSoftware\\Brave-Browser\\Application\\brave.exe") ||
        pathStr.includes("Microsoft\\Edge\\Application\\msedge.exe")
      );
    });
    const exe = findChromeExecutableWindows();
    expect(exe?.kind).toBe("chrome");
    expect(exe?.path).toMatch(/chrome\.exe$/);
    exists.mockRestore();
  });

  it("finds Chrome in Program Files on Windows", () => {
    const marker = path.win32.join("Program Files", "Google", "Chrome");
    const exists = mockExistsSync((pathValue) => pathValue.includes(marker));
    const exe = findChromeExecutableWindows();
    expect(exe?.kind).toBe("chrome");
    expect(exe?.path).toMatch(/chrome\.exe$/);
    exists.mockRestore();
  });

  it("returns null when no Chrome candidate exists on Windows", () => {
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(findChromeExecutableWindows()).toBeNull();
    exists.mockRestore();
  });

  it("resolves Windows executables without LOCALAPPDATA", () => {
    vi.stubEnv("LOCALAPPDATA", "");
    vi.stubEnv("ProgramFiles", "C:\\Program Files");
    vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
    const marker = path.win32.join(
      "Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    );
    const exists = mockExistsSync((pathValue) => pathValue.includes(marker));
    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "win32",
    );
    expect(exe?.kind).toBe("chrome");
    expect(exe?.path).toMatch(/chrome\.exe$/);
    exists.mockRestore();
  });

  it("reports reachability based on /json/version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }),
      } as unknown as Response),
    );
    await expect(isChromeReachable("http://127.0.0.1:12345", 50)).resolves.toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      } as unknown as Response),
    );
    await expect(isChromeReachable("http://127.0.0.1:12345", 50)).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(isChromeReachable("http://127.0.0.1:12345", 50)).resolves.toBe(false);
  });

  it("diagnoses /json/version responses that omit the websocket URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ Browser: "Chrome/Mock" }),
      } as unknown as Response),
    );

    const diagnostic = expectFailedChromeCdpDiagnostic(
      await diagnoseChromeCdp("http://127.0.0.1:12345", 50, 50),
    );
    expect(diagnostic.code).toBe("missing_websocket_debugger_url");
    expect(diagnostic.cdpUrl).toBe("http://127.0.0.1:12345");
  });

  it("allows loopback CDP probes while still blocking non-loopback private targets in strict SSRF mode", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }),
      } as unknown as Response)
      .mockRejectedValue(new Error("should not be called"));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      isChromeReachable("http://127.0.0.1:12345", 50, {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBe(true);
    await expect(
      isChromeReachable("http://169.254.169.254:12345", 50, {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBe(false);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks cross-host websocket pivots returned by /json/version in strict SSRF mode", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: "ws://169.254.169.254:9222/devtools/browser/pivot",
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    try {
      const addr = server.address() as AddressInfo;
      await expect(
        getChromeWebSocketUrl(`http://127.0.0.1:${addr.port}`, 1000, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports cdpReady only when Browser.getVersion command succeeds", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/health",
      onConnection: (wss) => {
        wss.on("connection", (ws) => {
          ws.on("message", (raw) => {
            let message: { id?: unknown; method?: unknown } | null = null;
            try {
              const text =
                typeof raw === "string"
                  ? raw
                  : Buffer.isBuffer(raw)
                    ? raw.toString("utf8")
                    : Array.isArray(raw)
                      ? Buffer.concat(raw).toString("utf8")
                      : Buffer.from(raw).toString("utf8");
              message = JSON.parse(text) as { id?: unknown; method?: unknown };
            } catch {
              return;
            }
            if (message?.method === "Browser.getVersion" && message.id === 1) {
              ws.send(
                JSON.stringify({
                  id: 1,
                  result: { product: "Chrome/Mock" },
                }),
              );
            }
          });
        });
      },
      run: async (baseUrl) => {
        await expect(isChromeCdpReady(baseUrl, 300, 400)).resolves.toBe(true);
      },
    });
  });

  it("reports cdpReady false when websocket opens but command channel is stale", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/stale",
      // Simulate a stale command channel: WS opens but never responds to commands.
      onConnection: (wss) => wss.on("connection", (_ws) => {}),
      run: async (baseUrl) => {
        await expect(isChromeCdpReady(baseUrl, 300, 5)).resolves.toBe(false);
      },
    });
  });

  it("diagnoses stale websocket command channels with the discovered websocket URL", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/stale-diagnostic",
      onConnection: (wss) => wss.on("connection", (_ws) => {}),
      run: async (baseUrl) => {
        const diagnostic = expectFailedChromeCdpDiagnostic(
          await diagnoseChromeCdp(baseUrl, 300, 50),
        );
        expect(diagnostic.code).toBe("websocket_health_command_timeout");
        expect(diagnostic.wsUrl).toMatch(/\/devtools\/browser\/stale-diagnostic$/);
      },
    });
  });

  it("formats diagnostics with redacted CDP credentials", () => {
    const formatted = formatChromeCdpDiagnostic({
      ok: false,
      code: "websocket_handshake_failed",
      cdpUrl: "https://user:pass@browserless.example.com?token=supersecret123",
      wsUrl: "wss://user:pass@browserless.example.com/devtools/browser/1?token=supersecret123",
      message: "connect ECONNREFUSED browserless.example.com",
      elapsedMs: 12,
    });

    expect(formatted).toContain("websocket_handshake_failed");
    expect(formatted).toContain("https://browserless.example.com/?token=***");
    expect(formatted).toContain("wss://browserless.example.com/devtools/browser/1?token=***");
    expect(formatted).not.toContain("user");
    expect(formatted).not.toContain("pass");
    expect(formatted).not.toContain("supersecret123");
  });

  it("probes direct ws:// CDP URLs (with /devtools/ path) via handshake instead of HTTP", async () => {
    // A direct WS endpoint like ws://host/devtools/browser/<uuid> is already
    // the handshake target — isChromeReachable must NOT hit /json/version.
    const fetchSpy = vi.fn().mockRejectedValue(new Error("should not be called"));
    vi.stubGlobal("fetch", fetchSpy);
    // No WS server listening → handshake fails → not reachable
    await expect(isChromeReachable("ws://127.0.0.1:19999/devtools/browser/ABC", 50)).resolves.toBe(
      false,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to HTTP /json/version discovery for a bare ws:// CDP URL (issue #68027)", async () => {
    // A user-supplied cdpUrl of `ws://host:port` without a /devtools/ path
    // points at Chrome's debug root; Chrome only accepts WS upgrades on the
    // specific path returned by `GET /json/version`. The reachability probe
    // must normalise the ws scheme to http for discovery, not attempt a
    // handshake at the bare root.
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/DISCOVERED",
      run: async (baseUrl) => {
        const url = new URL(baseUrl);
        const wsOnlyBase = `ws://${url.host}`;
        await expect(isChromeReachable(wsOnlyBase, 300)).resolves.toBe(true);
        await expect(getChromeWebSocketUrl(wsOnlyBase, 300)).resolves.toBe(
          `ws://${url.host}/devtools/browser/DISCOVERED`,
        );
      },
    });
  });

  it("uses HTTP discovery before readiness checks for a bare ws:// CDP URL", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/READY",
      onConnection: (wss) => {
        wss.on("connection", (ws) => {
          ws.on("message", (raw) => {
            const message = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
            if (message.method === "Browser.getVersion" && message.id === 1) {
              ws.send(
                JSON.stringify({
                  id: 1,
                  result: { product: "Chrome/Mock" },
                }),
              );
            }
          });
        });
      },
      run: async (baseUrl) => {
        const url = new URL(baseUrl);
        const wsOnlyBase = `ws://${url.host}?token=abc`;
        await expect(isChromeCdpReady(wsOnlyBase, 300, 400)).resolves.toBe(true);
        const diagnostic = expectReadyChromeCdpDiagnostic(
          await diagnoseChromeCdp(wsOnlyBase, 300, 400),
        );
        expect(diagnostic.wsUrl).toBe(`ws://${url.host}/devtools/browser/READY?token=abc`);
      },
    });
  });

  it("falls back to the bare WebSocket root when discovered Browserless endpoint rejects readiness", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/json/version")) {
        const addr = server.address() as AddressInfo;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            Browser: "Browserless/Mock",
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/e/bad`,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/e/bad")) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
        if (message.method === "Browser.getVersion" && message.id === 1) {
          ws.send(JSON.stringify({ id: 1, result: { product: "Browserless/Mock" } }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    try {
      const addr = server.address() as AddressInfo;
      const wsOnlyBase = `ws://127.0.0.1:${addr.port}?token=abc`;
      await expect(isChromeCdpReady(wsOnlyBase, 300, 400)).resolves.toBe(true);
      const diagnostic = expectReadyChromeCdpDiagnostic(
        await diagnoseChromeCdp(wsOnlyBase, 300, 400),
      );
      expect(diagnostic.wsUrl).toBe(wsOnlyBase);
      expect(diagnostic.browser).toBe("Browserless/Mock");
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports unreachable when a bare ws:// CDP URL points at a server with no /json/version and refuses WS", async () => {
    // Negative counterpart to the #68027 happy path — a bare ws URL
    // pointed at a port that neither serves /json/version nor accepts
    // WS upgrades must resolve false without hanging.
    const fetchSpy = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchSpy);
    // Port 19998 is not listening; the WS fallback probe will also fail.
    await expect(isChromeReachable("ws://127.0.0.1:19998", 50)).resolves.toBe(false);
    // fetch() must have been invoked — HTTP discovery is always tried first.
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("falls back to a direct WS probe when /json/version is unavailable for a bare ws:// URL", async () => {
    // Covers the WS-fallback path in isChromeReachable: /json/version returns
    // nothing (simulated by empty response) but the WS socket IS accepting
    // connections (Browserless/Browserbase-style provider).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}), // empty — no webSocketDebuggerUrl
      } as unknown as Response),
    );
    // A real WS server accepts the handshake.
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    try {
      await expect(isChromeReachable(`ws://127.0.0.1:${port}`, 500)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("falls back to a direct WS readiness check when /json/version has no debugger URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as unknown as Response),
    );
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
        if (message.method === "Browser.getVersion" && message.id === 1) {
          ws.send(JSON.stringify({ id: 1, result: { product: "Browserless/Mock" } }));
        }
      });
    });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    try {
      await expect(isChromeCdpReady(`ws://127.0.0.1:${port}`, 500, 500)).resolves.toBe(true);
      const diagnostic = expectReadyChromeCdpDiagnostic(
        await diagnoseChromeCdp(`ws://127.0.0.1:${port}`, 500, 500),
      );
      expect(diagnostic.wsUrl).toBe(`ws://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("returns the original ws:// URL from getChromeWebSocketUrl when /json/version provides no debugger URL", async () => {
    // Covers the getChromeWebSocketUrl WS-fallback: discovery succeeds but
    // webSocketDebuggerUrl is absent — the original URL is returned as-is.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as unknown as Response),
    );
    await expect(getChromeWebSocketUrl("ws://127.0.0.1:12345", 50)).resolves.toBe(
      "ws://127.0.0.1:12345",
    );
  });

  it("stopOpenClawChrome no-ops when process is already killed", async () => {
    const proc = makeChromeTestProc({ killed: true });
    await stopChromeWithProc(proc, 10);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("stopOpenClawChrome sends SIGTERM and returns once CDP is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const proc = makeChromeTestProc();
    await stopChromeWithProc(proc, 10);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stopOpenClawChrome escalates to SIGKILL when CDP stays reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }),
      } as unknown as Response),
    );
    const proc = makeChromeTestProc();
    await stopChromeWithProc(proc, 1);
    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });
});

describe("chrome executables", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses odd dotted browser version tokens using the last match", () => {
    expect(parseBrowserMajorVersion("Chromium 3.0/1.2.3")).toBe(1);
  });

  it("returns null when no dotted version token exists", () => {
    expect(parseBrowserMajorVersion("no version here")).toBeNull();
  });

  it("classifies beta Linux Google Chrome builds as canary", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === "/usr/bin/google-chrome-beta";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-beta",
    });
  });

  it("classifies unstable Linux Google Chrome builds as canary", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === "/usr/bin/google-chrome-unstable";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-unstable",
    });
  });

  it("finds Linux Google Chrome under /opt", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === "/opt/google/chrome/chrome";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "chrome",
      path: "/opt/google/chrome/chrome",
    });
  });
});

describe("browser chrome launch args", () => {
  it("does not force an about:blank tab at startup", () => {
    const args = buildOpenClawChromeLaunchArgs({
      resolved: {
        enabled: true,
        controlPort: 18791,
        cdpProtocol: "http",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPortRangeStart: 18800,
        cdpPortRangeEnd: 18810,
        evaluateEnabled: false,
        remoteCdpTimeoutMs: 1500,
        remoteCdpHandshakeTimeoutMs: 3000,
        localLaunchTimeoutMs: 15_000,
        localCdpReadyTimeoutMs: 8_000,
        actionTimeoutMs: 60_000,
        extraArgs: [],
        color: "#FF4500",
        headless: false,
        noSandbox: false,
        attachOnly: false,
        ssrfPolicy: { allowPrivateNetwork: true },
        tabCleanup: {
          enabled: true,
          idleMinutes: 120,
          maxTabsPerSession: 8,
          sweepMinutes: 5,
        },
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
        },
      },
      profile: {
        name: "openclaw",
        cdpUrl: "http://127.0.0.1:18800",
        cdpPort: 18800,
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        color: "#FF4500",
        driver: "openclaw",
        headless: false,
        attachOnly: false,
      },
      userDataDir: "/tmp/openclaw-test-user-data",
    });

    expect(args).not.toContain("about:blank");
    expect(args).toContain("--remote-debugging-port=18800");
    expect(args).toContain("--user-data-dir=/tmp/openclaw-test-user-data");
  });
});
