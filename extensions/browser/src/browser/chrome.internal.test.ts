import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

const ensurePortAvailableMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../infra/ports.js", () => ({
  ensurePortAvailable: ensurePortAvailableMock,
}));

// Shrink long launch/bootstrap timeouts so tests don't wait 15s for
// the CHROME_LAUNCH_READY_WINDOW_MS elapse-on-failure path.
vi.mock("./cdp-timeouts.js", async () => {
  const actual = await vi.importActual<typeof import("./cdp-timeouts.js")>("./cdp-timeouts.js");
  return {
    ...actual,
    CHROME_LAUNCH_READY_WINDOW_MS: 20,
    CHROME_LAUNCH_READY_POLL_MS: 5,
    CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS: 120,
    CHROME_BOOTSTRAP_PREFS_POLL_MS: 5,
    CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS: 40,
    CHROME_BOOTSTRAP_EXIT_POLL_MS: 5,
  };
});

import {
  buildOpenClawChromeLaunchArgs,
  getChromeWebSocketUrl,
  isChromeCdpReady,
  isChromeReachable,
  launchOpenClawChrome,
  resolveOpenClawUserDataDir,
  stopOpenClawChrome,
} from "./chrome.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";

/**
 * Covers the parts of chrome.ts that the mainline chrome.test.ts does
 * not exercise: launchOpenClawChrome (with child_process.spawn mocked),
 * canRunCdpHealthCommand all branches, canOpenWebSocket failure,
 * stopOpenClawChrome SIGKILL fallback, fs.exists() catch, default
 * profile name, buildOpenClawChromeLaunchArgs branches, and friends.
 */

type FakeProc = EventEmitter & {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  kill: (sig?: string) => boolean;
  stderr: EventEmitter;
};

function makeFakeProc(overrides: Partial<FakeProc> = {}): FakeProc {
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    killed: false,
    exitCode: null,
    kill: vi.fn((_sig?: string) => {
      proc.killed = true;
      return true;
    }),
    stderr,
  }) as unknown as FakeProc;
  return Object.assign(proc, overrides);
}

function effectiveSpawnCommand(call: unknown[] | undefined): unknown {
  const command = call?.[0];
  const args = call?.[1];
  if (
    command === "/bin/sh" &&
    Array.isArray(args) &&
    args[0] === "-c" &&
    typeof args[2] === "string"
  ) {
    return args[2];
  }
  return command;
}

async function withMockChromeCdpServer(params: {
  wsPath: string;
  onConnection?: (wss: WebSocketServer) => void;
  run: (baseUrl: string) => Promise<void>;
}) {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
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
    if (req.url !== params.wsPath) {
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

describe("chrome.ts internal", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    spawnMock.mockReset();
    ensurePortAvailableMock.mockReset();
    ensurePortAvailableMock.mockImplementation(async () => {});
  });

  describe("resolveOpenClawUserDataDir", () => {
    it("falls back to the default profile name when none is supplied", () => {
      const dir = resolveOpenClawUserDataDir();
      expect(dir.endsWith(path.join("openclaw", "user-data"))).toBe(true);
    });

    it("respects an explicit profile name", () => {
      const dir = resolveOpenClawUserDataDir("my-profile");
      expect(dir.endsWith(path.join("my-profile", "user-data"))).toBe(true);
    });
  });

  describe("buildOpenClawChromeLaunchArgs branches", () => {
    const baseResolved = (overrides: Partial<ResolvedBrowserConfig> = {}): ResolvedBrowserConfig =>
      ({
        headless: false,
        noSandbox: false,
        extraArgs: [],
        headlessSource: "default",
        ...overrides,
      }) as unknown as ResolvedBrowserConfig;

    const baseProfile: ResolvedBrowserProfile = {
      name: "openclaw",
      color: "#FF4500",
      cdpPort: 19222,
      cdpUrl: "http://127.0.0.1:19222",
      cdpIsLoopback: true,
      driver: "openclaw",
      headless: false,
      headlessSource: "default",
      attachOnly: false,
    } as unknown as ResolvedBrowserProfile;

    it("toggles headless args", () => {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: baseResolved({ headless: false }),
        profile: { ...baseProfile, headless: true, headlessSource: "profile" },
        userDataDir: "/tmp/foo",
      });
      expect(args).toContain("--headless=new");
      expect(args).toContain("--disable-gpu");
    });

    it("lets profile headless=false override global headless=true", () => {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: baseResolved({ headless: true, headlessSource: "config" }),
        profile: { ...baseProfile, headless: false, headlessSource: "profile" },
        userDataDir: "/tmp/foo",
      });
      expect(args).not.toContain("--headless=new");
      expect(args).not.toContain("--disable-gpu");
    });

    it("lets a request headless override beat env and profile headed settings", () => {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: baseResolved({ headless: false, headlessSource: "config" }),
        profile: { ...baseProfile, headless: false, headlessSource: "profile" },
        userDataDir: "/tmp/foo",
        headlessOverride: true,
        env: { OPENCLAW_BROWSER_HEADLESS: "0" },
      });
      expect(args).toContain("--headless=new");
      expect(args).toContain("--disable-gpu");
    });

    it("adds headless args for Linux local managed profiles without a display", () => {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: baseResolved(),
        profile: baseProfile,
        userDataDir: "/tmp/foo",
        platform: "linux",
        env: { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
      });
      expect(args).toContain("--headless=new");
      expect(args).toContain("--disable-gpu");
    });

    it("does not apply Linux no-display fallback to remote profiles", () => {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: baseResolved(),
        profile: {
          ...baseProfile,
          cdpHost: "10.0.0.42",
          cdpUrl: "http://10.0.0.42:9222",
          cdpIsLoopback: false,
        },
        userDataDir: "/tmp/foo",
        platform: "linux",
        env: { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
      });
      expect(args).not.toContain("--headless=new");
      expect(args).not.toContain("--disable-gpu");
    });

    it("toggles no-sandbox args", () => {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: baseResolved({ noSandbox: true }),
        profile: baseProfile,
        userDataDir: "/tmp/foo",
      });
      expect(args).toContain("--no-sandbox");
      expect(args).not.toContain("--disable-setuid-sandbox");
    });

    it("adds --disable-dev-shm-usage on linux", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        const args = buildOpenClawChromeLaunchArgs({
          resolved: baseResolved(),
          profile: baseProfile,
          userDataDir: "/tmp/foo",
        });
        expect(args).toContain("--disable-dev-shm-usage");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("propagates extraArgs", () => {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: baseResolved({
          extraArgs: ["--proxy-server=http://localhost:3128", "--mute-audio"],
        }),
        profile: baseProfile,
        userDataDir: "/tmp/foo",
      });
      expect(args).toContain("--proxy-server=http://localhost:3128");
      expect(args).toContain("--mute-audio");
      expect(args).not.toContain("--no-proxy-server");
    });

    it("launches managed Chrome direct by default", () => {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: baseResolved(),
        profile: baseProfile,
        userDataDir: "/tmp/foo",
      });
      expect(args).toContain("--no-proxy-server");
    });
  });

  describe("fs.exists() catch branch", () => {
    it("treats a throwing fs.existsSync (for prefs files) as non-existent to force bootstrap", async () => {
      // Make existsSync throw ONLY for Local State / Preferences checks
      // — other candidate-executable probes still return true so
      // resolveBrowserExecutable succeeds and we actually reach the
      // exists() invocation inside launchOpenClawChrome.
      let prefsProbeCount = 0;
      const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith("Local State") || s.endsWith("Preferences")) {
          prefsProbeCount += 1;
          if (prefsProbeCount === 1) {
            throw new Error("EACCES");
          }
          return true;
        }
        if (
          s.includes("Google Chrome") ||
          s.includes("google-chrome") ||
          s.includes("/usr/bin/chromium")
        ) {
          return true;
        }
        return false;
      });
      spawnMock.mockImplementation(() => makeFakeProc());

      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/CATCH_EXISTS",
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          const profile = {
            name: "openclaw",
            color: "#FF4500",
            cdpPort: port,
            cdpUrl: baseUrl,
            cdpIsLoopback: true,
          } as unknown as ResolvedBrowserProfile;
          const resolved = {
            headless: true,
            noSandbox: true,
            extraArgs: [],
          } as unknown as ResolvedBrowserConfig;
          const running = await launchOpenClawChrome(resolved, profile);
          running.proc.kill?.("SIGTERM");
        },
      });
      existsSpy.mockRestore();
    });
  });

  describe("launchOpenClawChrome", () => {
    let tmpDir = "";

    beforeEach(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-launch-"));
    });

    afterEach(async () => {
      if (tmpDir) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    const makeProfile = (cdpPort: number): ResolvedBrowserProfile =>
      ({
        name: path.basename(tmpDir),
        color: "#FF4500",
        cdpPort,
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        cdpIsLoopback: true,
      }) as unknown as ResolvedBrowserProfile;

    const makeResolved = (): ResolvedBrowserConfig =>
      ({
        headless: true,
        noSandbox: true,
        extraArgs: [],
        localLaunchTimeoutMs: 15_000,
        localCdpReadyTimeoutMs: 8_000,
      }) as unknown as ResolvedBrowserConfig;

    it("rejects a remote profile before attempting to spawn", async () => {
      const profile = {
        name: "openclaw",
        color: "#FF4500",
        cdpPort: 19222,
        cdpUrl: "http://example.com:19222",
        cdpIsLoopback: false,
      } as unknown as ResolvedBrowserProfile;
      await expect(launchOpenClawChrome(makeResolved(), profile)).rejects.toThrow(
        /is remote; cannot launch local Chrome/,
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("throws when no supported browser executable is found", async () => {
      // Strip all candidate executables — override config so no explicit
      // path is set, then mock existsSync to return false for everything.
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const profile = makeProfile(51111);
      await expect(launchOpenClawChrome(makeResolved(), profile)).rejects.toThrow(
        /No supported browser found/,
      );
    });

    it("completes successfully when Chrome reports /json/version and CDP is reachable", async () => {
      // Mock executable discovery to a truthy path.
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        // Pretend the mac Chrome binary exists and the preference files exist.
        if (
          s.includes("Google Chrome") ||
          s.includes("google-chrome") ||
          s.includes("/usr/bin/chromium")
        ) {
          return true;
        }
        if (s.endsWith("Local State") || s.endsWith("Preferences")) {
          return true;
        }
        return false;
      });

      let spawnCalls = 0;
      spawnMock.mockImplementation(() => {
        spawnCalls += 1;
        return makeFakeProc();
      });
      vi.stubEnv("HTTP_PROXY", "http://proxy.test:8080");
      vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8443");
      vi.stubEnv("NO_PROXY", "localhost");

      // Set up a real HTTP server impersonating Chrome's /json/version.
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/LAUNCHED",
        run: async (baseUrl) => {
          const port = new URL(baseUrl).port;
          const profile = makeProfile(Number(port));
          const running = await launchOpenClawChrome(makeResolved(), profile);
          expect(running.pid).toBe(4242);
          expect(spawnCalls).toBeGreaterThanOrEqual(1);
          const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
          expect(spawnOptions.env?.HTTP_PROXY).toBeUndefined();
          expect(spawnOptions.env?.HTTPS_PROXY).toBeUndefined();
          expect(spawnOptions.env?.NO_PROXY).toBeUndefined();
          // Cleanup.
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("uses profile executablePath over global executablePath when launching", async () => {
      const originalPlatform = process.platform;
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (s === "/tmp/profile-chrome" || s.endsWith("Local State") || s.endsWith("Preferences")) {
          return true;
        }
        return false;
      });
      spawnMock.mockImplementation(() => makeFakeProc());

      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        await withMockChromeCdpServer({
          wsPath: "/devtools/browser/PROFILE_EXE",
          run: async (baseUrl) => {
            const port = new URL(baseUrl).port;
            const profile = { ...makeProfile(Number(port)), executablePath: "/tmp/profile-chrome" };
            const resolved = {
              ...makeResolved(),
              executablePath: "/tmp/global-chrome",
            } as ResolvedBrowserConfig;
            const running = await launchOpenClawChrome(resolved, profile);
            expect(effectiveSpawnCommand(spawnMock.mock.calls[0])).toBe("/tmp/profile-chrome");
            running.proc.kill?.("SIGTERM");
          },
        });
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("clears stale singleton locks and retries once after profile-in-use launch failure", async () => {
      let cdpReachable = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (!cdpReachable) {
            throw new Error("ECONNREFUSED");
          }
          return {
            ok: true,
            json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }),
          } as unknown as Response;
        }),
      );
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (s === "/tmp/profile-chrome" || s.endsWith("Local State") || s.endsWith("Preferences")) {
          return true;
        }
        return false;
      });

      let spawnCalls = 0;
      const firstProc = makeFakeProc();
      const secondProc = makeFakeProc();
      spawnMock.mockImplementation(() => {
        spawnCalls += 1;
        if (spawnCalls === 1) {
          setTimeout(() => {
            firstProc.stderr.emit(
              "data",
              Buffer.from("The profile appears to be in use by another Chromium process"),
            );
          }, 0);
          return firstProc;
        }
        cdpReachable = true;
        return secondProc;
      });

      const profile = { ...makeProfile(18888), executablePath: "/tmp/profile-chrome" };
      const userDataDir = resolveOpenClawUserDataDir(profile.name);
      await fsp.mkdir(userDataDir, { recursive: true });
      await fsp.writeFile(path.join(userDataDir, "SingletonCookie"), "cookie");
      await fsp.writeFile(path.join(userDataDir, "SingletonSocket"), "socket");
      await fsp.symlink("remote-host-535", path.join(userDataDir, "SingletonLock"));

      try {
        const running = await launchOpenClawChrome(makeResolved(), profile);
        expect(running.proc).toBe(secondProc);
        expect(firstProc.kill).toHaveBeenCalledWith("SIGKILL");
        expect(spawnCalls).toBe(2);
        expect(fs.existsSync(path.join(userDataDir, "SingletonLock"))).toBe(false);
        expect(fs.existsSync(path.join(userDataDir, "SingletonSocket"))).toBe(false);
        running.proc.kill?.("SIGTERM");
      } finally {
        await fsp.rm(userDataDir, { recursive: true, force: true });
      }
    });

    it("throws with stderr hint + sandbox hint when CDP never becomes reachable", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        vi.spyOn(fs, "existsSync").mockImplementation((p) => {
          const s = String(p);
          if (
            s.includes("Google Chrome") ||
            s.includes("google-chrome") ||
            s.includes("/usr/bin/chromium")
          ) {
            return true;
          }
          if (s.endsWith("Local State") || s.endsWith("Preferences")) {
            return true;
          }
          return false;
        });
        const fakeProc = makeFakeProc();
        spawnMock.mockReturnValue(fakeProc);
        // Leak some stderr into the buffer so the hint renders.
        setTimeout(() => fakeProc.stderr.emit("data", Buffer.from("crash dump\n")), 10);

        // fetch always fails → isChromeReachable returns false every poll.
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

        const resolved = {
          headless: false,
          noSandbox: false, // sandbox hint will render on linux
          extraArgs: [],
        } as unknown as ResolvedBrowserConfig;
        const profile = makeProfile(55555);
        await expect(launchOpenClawChrome(resolved, profile)).rejects.toThrow(
          /Failed to start Chrome CDP/,
        );
        expect(fakeProc.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("uses the configured local launch timeout while waiting for CDP discovery", async () => {
      vi.useFakeTimers();
      try {
        const executablePath = path.join(tmpDir, "chrome");
        await fsp.writeFile(executablePath, "");
        const existsSync = fs.existsSync.bind(fs);
        vi.spyOn(fs, "existsSync").mockImplementation((p) => {
          const s = String(p);
          if (s.endsWith("Local State") || s.endsWith("Preferences")) {
            return true;
          }
          return existsSync(p);
        });
        const fakeProc = makeFakeProc();
        spawnMock.mockReturnValue(fakeProc);
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

        const resolved = {
          ...makeResolved(),
          executablePath,
          localLaunchTimeoutMs: 1,
        };
        const profile = makeProfile(55556);
        const rejection = expect(launchOpenClawChrome(resolved, profile)).rejects.toThrow(
          /Failed to start Chrome CDP/,
        );

        await vi.advanceTimersByTimeAsync(10);
        await rejection;
        expect(fakeProc.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("stopOpenClawChrome SIGKILL fallback", () => {
    it("escalates to SIGKILL when CDP keeps reporting reachable past the deadline", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }),
        } as unknown as Response),
      );
      const proc = makeFakeProc();
      await stopOpenClawChrome(
        { proc, cdpPort: 12345 } as unknown as Parameters<typeof stopOpenClawChrome>[0],
        1,
      );
      expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    });
  });

  describe("fetchChromeVersion non-object branch", () => {
    it("returns null when the /json/version response JSON is not an object", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => null,
        } as unknown as Response),
      );
      // isChromeReachable invokes fetchChromeVersion; when it returns null,
      // Boolean(null) === false → reachability is false.
      await expect(isChromeReachable("http://127.0.0.1:12345", 50)).resolves.toBe(false);
    });
  });

  describe("getChromeWebSocketUrl missing-debugger-url", () => {
    it("returns null when /json/version omits webSocketDebuggerUrl", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ Browser: "Chrome/Mock" }),
        } as unknown as Response),
      );
      await expect(getChromeWebSocketUrl("http://127.0.0.1:12345", 50)).resolves.toBeNull();
    });
  });

  describe("isChromeCdpReady no-ws-url branch", () => {
    it("returns false when getChromeWebSocketUrl resolves to null", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({}),
        } as unknown as Response),
      );
      await expect(isChromeCdpReady("http://127.0.0.1:12345", 50, 50)).resolves.toBe(false);
    });
  });

  describe("canRunCdpHealthCommand branches", () => {
    it("returns false when the ws upgrade is refused", async () => {
      // isChromeCdpReady -> getChromeWebSocketUrl -> canRunCdpHealthCommand.
      // Point at a port that doesn't accept ws upgrades at the /devtools path
      // to trigger the error-event branch.
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/MISMATCH",
        onConnection: (wss) => {
          wss.on("connection", (_ws) => {
            // Accept but never respond → timeout-based failure.
          });
        },
        run: async (baseUrl) => {
          await expect(isChromeCdpReady(baseUrl, 50, 10)).resolves.toBe(false);
        },
      });
    });

    it("returns false when the health command response is malformed JSON", async () => {
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/BAD_JSON",
        onConnection: (wss) => {
          wss.on("connection", (ws) => {
            ws.on("message", () => {
              ws.send("not-json-at-all");
              setTimeout(() => ws.close(), 1);
            });
          });
        },
        run: async (baseUrl) => {
          await expect(isChromeCdpReady(baseUrl, 50, 10)).resolves.toBe(false);
        },
      });
    });

    it("ignores messages whose id does not match the health probe id", async () => {
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/WRONG_ID",
        onConnection: (wss) => {
          wss.on("connection", (ws) => {
            ws.on("message", () => {
              ws.send(JSON.stringify({ id: 42, result: { product: "Chrome" } }));
              setTimeout(() => ws.close(), 1);
            });
          });
        },
        run: async (baseUrl) => {
          await expect(isChromeCdpReady(baseUrl, 50, 10)).resolves.toBe(false);
        },
      });
    });

    it("returns true when Browser.getVersion responds with an object", async () => {
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/OK",
        onConnection: (wss) => {
          wss.on("connection", (ws) => {
            ws.on("message", (raw) => {
              const text = rawDataToString(raw);
              const msg = JSON.parse(text) as { id?: number };
              if (msg.id === 1) {
                ws.send(JSON.stringify({ id: 1, result: { product: "Chrome/Mock" } }));
              }
            });
          });
        },
        run: async (baseUrl) => {
          await expect(isChromeCdpReady(baseUrl, 500, 100)).resolves.toBe(true);
        },
      });
    });
  });

  describe("canOpenWebSocket", () => {
    it("resolves false when the direct-ws probe cannot connect", async () => {
      // Bind a ws server and then close it, so connecting to it fails.
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
      const port = (wss.address() as { port: number }).port;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await expect(
        isChromeReachable(`ws://127.0.0.1:${port}/devtools/browser/GONE`, 50),
      ).resolves.toBe(false);
    });

    it("resolves true when the direct-ws handshake succeeds", async () => {
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
      const port = (wss.address() as { port: number }).port;
      try {
        // Direct /devtools/ WS URL — isChromeReachable goes through
        // canOpenWebSocket. The server accepts the upgrade; the probe
        // resolves true as soon as 'open' fires.
        await expect(
          isChromeReachable(`ws://127.0.0.1:${port}/devtools/browser/OK`, 500),
        ).resolves.toBe(true);
      } finally {
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    });
  });

  describe("getChromeWebSocketUrl direct-ws short-circuit", () => {
    it("returns the input URL as-is for handshake-ready direct ws endpoints", async () => {
      // Covers the `return cdpUrl;` early-return on a direct ws endpoint.
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const out = await getChromeWebSocketUrl("ws://127.0.0.1:19222/devtools/browser/DIRECT", 50);
      expect(out).toBe("ws://127.0.0.1:19222/devtools/browser/DIRECT");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("canRunCdpHealthCommand error/close/throw-on-send branches", () => {
    it("resolves false when the ws client cannot connect to the discovered ws URL", async () => {
      // Serve /json/version pointing at a port that's not actually
      // accepting ws upgrades — the canRunCdpHealthCommand probe will
      // fire its 'error' handler during handshake.
      const dead = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>((resolve) => dead.once("listening", () => resolve()));
      const deadPort = (dead.address() as { port: number }).port;
      await new Promise<void>((resolve) => dead.close(() => resolve()));
      const server = createServer((req, res) => {
        if (req.url === "/json/version") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              webSocketDebuggerUrl: `ws://127.0.0.1:${deadPort}/devtools/browser/DEAD`,
            }),
          );
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      try {
        const addr = server.address() as AddressInfo;
        await expect(isChromeCdpReady(`http://127.0.0.1:${addr.port}`, 50, 10)).resolves.toBe(
          false,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("resolves false when the ws 'close' event fires before a response arrives", async () => {
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/CLOSE",
        onConnection: (wss) => {
          wss.on("connection", (ws) => {
            // Immediately close with no response, triggering the 'close' branch.
            setTimeout(() => ws.close(), 10);
          });
        },
        run: async (baseUrl) => {
          await expect(isChromeCdpReady(baseUrl, 50, 10)).resolves.toBe(false);
        },
      });
    });
  });

  describe("isChromeCdpReady swallowed errors", () => {
    it("returns false when getChromeWebSocketUrl rejects (SSRF-blocked)", async () => {
      // Covers the `.catch(() => null)` arrow on getChromeWebSocketUrl in
      // isChromeCdpReady by pointing at a private-IP cdp url under strict SSRF.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/x" }),
        } as unknown as Response),
      );
      await expect(
        isChromeCdpReady("http://169.254.169.254:9222", 50, 50, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).resolves.toBe(false);
    });
  });

  describe("launchOpenClawChrome remaining branches", () => {
    it("skips decoration entirely when the profile is already decorated", async () => {
      // Covers the `needsDecorate` false branch by writing a real,
      // properly-shaped Local State + Preferences pair that matches
      // the desired name and color seed so isProfileDecorated returns
      // true on the first check.
      const stageDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-decorated-"));
      try {
        const profileName = path.basename(stageDir);
        const colorHex = "#FF4500";
        const colorInt = ((0xff << 24) | 0xff4500) >> 0;
        const userDataDir = path.join(resolveOpenClawUserDataDir(profileName));
        await fsp.mkdir(path.join(userDataDir, "Default"), { recursive: true });
        await fsp.writeFile(
          path.join(userDataDir, "Local State"),
          JSON.stringify({
            profile: {
              info_cache: {
                Default: {
                  name: profileName,
                  profile_color_seed: colorInt,
                },
              },
            },
          }),
        );
        await fsp.writeFile(
          path.join(userDataDir, "Default", "Preferences"),
          JSON.stringify({
            browser: { theme: { user_color2: colorInt } },
            autogenerated: { theme: { color: colorInt } },
          }),
        );
        vi.spyOn(fs, "existsSync").mockImplementation((p) => {
          const s = String(p);
          if (
            s.includes("Google Chrome") ||
            s.includes("google-chrome") ||
            s.includes("/usr/bin/chromium")
          ) {
            return true;
          }
          // Fall through to real fs for the user-data-dir files.
          return fs.statSync(s, { throwIfNoEntry: false }) !== undefined;
        });
        spawnMock.mockImplementation(() => makeFakeProc());
        await withMockChromeCdpServer({
          wsPath: "/devtools/browser/DECORATED",
          run: async (baseUrl) => {
            const port = Number(new URL(baseUrl).port);
            const profile = {
              name: profileName,
              color: colorHex,
              cdpPort: port,
              cdpUrl: baseUrl,
              cdpIsLoopback: true,
            } as unknown as ResolvedBrowserProfile;
            const resolved = {
              headless: true,
              noSandbox: true,
              extraArgs: [],
            } as unknown as ResolvedBrowserConfig;
            const running = await launchOpenClawChrome(resolved, profile);
            running.proc.kill?.("SIGTERM");
          },
        });
      } finally {
        await fsp.rm(stageDir, { recursive: true, force: true });
        const staged = resolveOpenClawUserDataDir(path.basename(stageDir));
        await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("falls back to the default color when profile.color is undefined", async () => {
      // Covers the `profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR` coalescing.
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (
          s.includes("Google Chrome") ||
          s.includes("google-chrome") ||
          s.includes("/usr/bin/chromium")
        ) {
          return true;
        }
        if (s.endsWith("Local State") || s.endsWith("Preferences")) {
          return true;
        }
        return false;
      });
      spawnMock.mockImplementation(() => makeFakeProc());
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/NO_COLOR",
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          const profile = {
            name: "openclaw",
            color: undefined,
            cdpPort: port,
            cdpUrl: baseUrl,
            cdpIsLoopback: true,
          } as unknown as ResolvedBrowserProfile;
          const resolved = {
            headless: true,
            noSandbox: true,
            extraArgs: [],
          } as unknown as ResolvedBrowserConfig;
          const running = await launchOpenClawChrome(resolved, profile);
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("buffers stderr chunks when Chrome emits diagnostics while CDP comes up", async () => {
      // Covers onStderr (pushing chunks to stderrChunks) plus the
      // stderrHint truthy branch on failure.
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (
          s.includes("Google Chrome") ||
          s.includes("google-chrome") ||
          s.includes("/usr/bin/chromium")
        ) {
          return true;
        }
        if (s.endsWith("Local State") || s.endsWith("Preferences")) {
          return true;
        }
        return false;
      });
      const fakeProc = makeFakeProc();
      spawnMock.mockImplementation(() => {
        // Synthesize stderr data shortly after spawn.
        setTimeout(() => fakeProc.stderr.emit("data", Buffer.from("chrome crash log\n")), 5);
        return fakeProc;
      });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      const profile = {
        name: "openclaw-stderr",
        color: "#FF4500",
        cdpPort: 54321,
        cdpUrl: "http://127.0.0.1:54321",
        cdpIsLoopback: true,
      } as unknown as ResolvedBrowserProfile;
      const resolved = {
        headless: true,
        noSandbox: true,
        extraArgs: [],
      } as unknown as ResolvedBrowserConfig;
      await expect(launchOpenClawChrome(resolved, profile)).rejects.toThrow(/Chrome stderr:/);
    });

    it("omits the sandbox hint on non-linux platforms", async () => {
      // Covers the else side of `process.platform === 'linux' && !resolved.noSandbox ? ... : ''`.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });
      try {
        vi.spyOn(fs, "existsSync").mockImplementation((p) => {
          const s = String(p);
          if (
            s.includes("Google Chrome") ||
            s.includes("google-chrome") ||
            s.includes("/usr/bin/chromium")
          ) {
            return true;
          }
          if (s.endsWith("Local State") || s.endsWith("Preferences")) {
            return true;
          }
          return false;
        });
        spawnMock.mockImplementation(() => makeFakeProc());
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
        const profile = {
          name: "openclaw-mac",
          color: "#FF4500",
          cdpPort: 54322,
          cdpUrl: "http://127.0.0.1:54322",
          cdpIsLoopback: true,
        } as unknown as ResolvedBrowserProfile;
        const resolved = {
          headless: true,
          noSandbox: false,
          extraArgs: [],
        } as unknown as ResolvedBrowserConfig;
        let caught: unknown;
        try {
          await launchOpenClawChrome(resolved, profile);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).not.toContain("Hint: If running in a container");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("breaks out of the bootstrap prefs-wait loop as soon as both files exist", async () => {
      // Covers the `if (exists(localStatePath) && exists(preferencesPath)) break;` branch.
      // Use a wallclock flag that the mock checks each call so the loop
      // iterates (awaiting its 100ms setTimeout) once with prefs-absent,
      // then the flag flips and the next iteration hits the break.
      let prefsVisible = false;
      setTimeout(() => {
        prefsVisible = true;
      }, 50);
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (
          s.includes("Google Chrome") ||
          s.includes("google-chrome") ||
          s.includes("/usr/bin/chromium")
        ) {
          return true;
        }
        if (s.endsWith("Local State") || s.endsWith("Preferences")) {
          return prefsVisible;
        }
        return false;
      });
      const bootstrapProc = makeFakeProc({ exitCode: 0 });
      const runtimeProc = makeFakeProc();
      let spawnCount = 0;
      spawnMock.mockImplementation(() => {
        spawnCount += 1;
        return spawnCount === 1 ? bootstrapProc : runtimeProc;
      });
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/BOOTSTRAP_BREAK",
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          const profile = {
            name: "openclaw",
            color: "#FF4500",
            cdpPort: port,
            cdpUrl: baseUrl,
            cdpIsLoopback: true,
          } as unknown as ResolvedBrowserProfile;
          const resolved = {
            headless: true,
            noSandbox: true,
            extraArgs: [],
          } as unknown as ResolvedBrowserConfig;
          const running = await launchOpenClawChrome(resolved, profile);
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("breaks out of the bootstrap exit-wait loop once the child reports an exit code", async () => {
      // Covers the `if (bootstrap.exitCode != null) break;` branch.
      let prefsProbeCount = 0;
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (
          s.includes("Google Chrome") ||
          s.includes("google-chrome") ||
          s.includes("/usr/bin/chromium")
        ) {
          return true;
        }
        if (s.endsWith("Local State") || s.endsWith("Preferences")) {
          prefsProbeCount += 1;
          return prefsProbeCount > 2;
        }
        return false;
      });
      const bootstrapProc = makeFakeProc();
      const runtimeProc = makeFakeProc();
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          // Set exitCode shortly after spawn so the exit-wait loop breaks.
          setTimeout(() => {
            bootstrapProc.exitCode = 0;
          }, 25);
          return bootstrapProc;
        }
        return runtimeProc;
      });
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/EXIT_BREAK",
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          const profile = {
            name: "openclaw",
            color: "#FF4500",
            cdpPort: port,
            cdpUrl: baseUrl,
            cdpIsLoopback: true,
          } as unknown as ResolvedBrowserProfile;
          const resolved = {
            headless: true,
            noSandbox: true,
            extraArgs: [],
          } as unknown as ResolvedBrowserConfig;
          const running = await launchOpenClawChrome(resolved, profile);
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("logs a warning when decorateOpenClawProfile throws and still returns a running Chrome", async () => {
      // Covers the decoration catch branch (log.warn).
      const { decorateOpenClawProfile } = await import("./chrome.profile-decoration.js");
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (
          s.includes("Google Chrome") ||
          s.includes("google-chrome") ||
          s.includes("/usr/bin/chromium")
        ) {
          return true;
        }
        if (s.endsWith("Local State") || s.endsWith("Preferences")) {
          return true;
        }
        return false;
      });
      const decorationSpy = vi
        .spyOn({ decorateOpenClawProfile }, "decorateOpenClawProfile")
        .mockImplementation(() => {
          throw new Error("decoration blew up");
        });
      // The real decoration throws via our writes — fake by spying on
      // fs.writeFileSync to throw for the marker file.
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(".openclaw-profile-decorated") || s.endsWith("Preferences")) {
          throw new Error("write blew up");
        }
      });
      spawnMock.mockImplementation(() => makeFakeProc());
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/DECO_WARN",
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          const profile = {
            name: "openclaw-warn",
            color: "#FF4500",
            cdpPort: port,
            cdpUrl: baseUrl,
            cdpIsLoopback: true,
          } as unknown as ResolvedBrowserProfile;
          const resolved = {
            headless: true,
            noSandbox: true,
            extraArgs: [],
          } as unknown as ResolvedBrowserConfig;
          const running = await launchOpenClawChrome(resolved, profile);
          running.proc.kill?.("SIGTERM");
        },
      });
      decorationSpy.mockRestore();
      writeSpy.mockRestore();
    });

    it("logs pid as -1 when the spawned proc reports no pid", async () => {
      // Covers the `proc.pid ?? -1` falsy side.
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (
          s.includes("Google Chrome") ||
          s.includes("google-chrome") ||
          s.includes("/usr/bin/chromium")
        ) {
          return true;
        }
        if (s.endsWith("Local State") || s.endsWith("Preferences")) {
          return true;
        }
        return false;
      });
      spawnMock.mockImplementation(() => {
        const fp = makeFakeProc();
        fp.pid = undefined;
        return fp;
      });
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/NO_PID",
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          const profile = {
            name: "openclaw-nopid",
            color: "#FF4500",
            cdpPort: port,
            cdpUrl: baseUrl,
            cdpIsLoopback: true,
          } as unknown as ResolvedBrowserProfile;
          const resolved = {
            headless: true,
            noSandbox: true,
            extraArgs: [],
          } as unknown as ResolvedBrowserConfig;
          const running = await launchOpenClawChrome(resolved, profile);
          expect(running.pid).toBe(-1);
          running.proc.kill?.("SIGTERM");
        },
      });
    });
  });
});
