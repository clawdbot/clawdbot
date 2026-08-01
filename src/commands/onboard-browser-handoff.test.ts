import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  detectGraphicalSession,
  probeBrowserHatchGateway,
  runBrowserHatchHandoff,
} from "./onboard-browser-handoff.js";

describe("probeBrowserHatchGateway", () => {
  it("skips a disabled Control UI without touching the network", async () => {
    const result = await probeBrowserHatchGateway({
      config: { gateway: { controlUi: { enabled: false } } },
    });
    expect(result).toEqual({ ok: false, detail: "control ui disabled" });
  });
});

const target = {
  config: {},
  dashboardUrl: "http://127.0.0.1:18789/#token=test-token",
  sshHint: "ssh -N -L 18789:127.0.0.1:18789 user@host",
  wsUrl: "ws://127.0.0.1:18789",
  token: "test-token",
};

describe("detectGraphicalSession", () => {
  it.each([
    { platform: "darwin", env: {}, expected: true },
    { platform: "darwin", env: { SSH_CONNECTION: "client server" }, expected: false },
    { platform: "darwin", env: { SSH_TTY: "/dev/ttys001" }, expected: false },
    { platform: "linux", env: {}, expected: false },
    { platform: "linux", env: { DISPLAY: ":0" }, expected: true },
    { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, expected: true },
    {
      platform: "linux",
      env: { DISPLAY: ":0", SSH_CONNECTION: "client server" },
      expected: false,
    },
    { platform: "win32", env: {}, expected: true },
    { platform: "win32", env: { SSH_TTY: "ssh" }, expected: false },
  ] satisfies Array<{
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    expected: boolean;
  }>)("$platform with $env reports graphical=$expected", ({ platform, env, expected }) => {
    expect(detectGraphicalSession(env, platform)).toBe(expected);
  });
});

describe("runBrowserHatchHandoff", () => {
  it.each([
    { platform: "darwin" as const, env: {} },
    { platform: "linux" as const, env: { DISPLAY: ":0" } },
    { platform: "win32" as const, env: {} },
  ])("opens once in a $platform GUI session", async ({ platform, env }) => {
    const prompter = createWizardPrompter();
    const openBrowser = vi.fn(async () => true);
    const probePresence = vi
      .fn()
      .mockResolvedValueOnce({ reachable: true as const, clientKeys: [] })
      .mockResolvedValue({ reachable: true as const, clientKeys: ["new-control-ui"] });

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env,
        platform,
        openBrowser,
        resolveTarget: async () => target,
        probePresence,
      },
    );

    expect(result).toEqual({ handedOff: true });
    expect(openBrowser).toHaveBeenCalledOnce();
    expect(openBrowser).toHaveBeenCalledWith(target.dashboardUrl);
    expect(probePresence).toHaveBeenCalledTimes(2);
    expect(prompter.note).toHaveBeenCalledWith(
      "Dashboard connected — continuing in your browser.",
      "Continue in your browser",
    );
  });

  it.each([
    { name: "headless Linux", env: {} },
    { name: "Linux SSH", env: { DISPLAY: ":0", SSH_CONNECTION: "client server" } },
  ])("prints the authenticated URL and waits longer in $name", async ({ env }) => {
    const prompter = createWizardPrompter();
    const openBrowser = vi.fn(async () => true);
    const probePresence = vi.fn(async () => ({ reachable: true as const, clientKeys: [] }));
    const pollForClient = vi.fn(async ({ baselineClientKeys }) => {
      expect([...baselineClientKeys]).toEqual([]);
      return { connected: true as const };
    });

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env,
        platform: "linux",
        openBrowser,
        resolveTarget: async () => target,
        probePresence,
        pollForClient,
      },
    );

    expect(result).toEqual({ handedOff: true });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(pollForClient).toHaveBeenCalledWith(
      expect.objectContaining({ target, timeoutMs: 300_000 }),
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(target.dashboardUrl),
      "Continue in your browser",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(target.sshHint),
      "Continue in your browser",
    );
  });

  it("prints the URL when browser launch fails", async () => {
    const prompter = createWizardPrompter();

    await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: {},
        platform: "darwin",
        openBrowser: vi.fn(async () => false),
        resolveTarget: async () => target,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(target.dashboardUrl),
      "Continue in your browser",
    );
  });

  it("returns the poll timeout without claiming a handoff", async () => {
    const prompter = createWizardPrompter();

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: { DISPLAY: ":0" },
        platform: "linux",
        openBrowser: vi.fn(async () => true),
        resolveTarget: async () => target,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    expect(result).toEqual({ handedOff: false, reason: "timeout" });
    expect(prompter.note).not.toHaveBeenCalledWith(
      "Dashboard connected — continuing in your browser.",
      expect.anything(),
    );
  });

  it("bounds the final presence probe by the remaining handoff time", async () => {
    const prompter = createWizardPrompter();
    const probeTimeouts: number[] = [];
    let elapsedMs = 0;
    let baselineCaptured = false;

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: {},
        platform: "darwin",
        openBrowser: vi.fn(async () => true),
        resolveTarget: async () => target,
        probePresence: async (_target, timeoutMs) => {
          probeTimeouts.push(timeoutMs);
          if (!baselineCaptured) {
            baselineCaptured = true;
            return { reachable: true, clientKeys: ["existing-control-ui"] };
          }
          elapsedMs += timeoutMs / 2;
          return { reachable: true, clientKeys: ["existing-control-ui"] };
        },
        now: () => elapsedMs,
        sleep: async (ms) => {
          elapsedMs += ms;
        },
      },
    );

    expect(result).toEqual({ handedOff: false, reason: "timeout" });
    expect(elapsedMs).toBe(60_000);
    expect(probeTimeouts.at(-1)).toBe(1_000);
    expect(probeTimeouts.every((timeoutMs) => timeoutMs <= 5_000)).toBe(true);
  });

  it("passes token-output suppression to dashboard target resolution", async () => {
    const prompter = createWizardPrompter();
    const resolveTarget = vi.fn(async () => target);

    await runBrowserHatchHandoff(
      { config: {}, prompter, suppressTokenOutput: true },
      {
        env: {},
        platform: "darwin",
        openBrowser: vi.fn(async () => true),
        resolveTarget,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    expect(resolveTarget).toHaveBeenCalledWith({}, {}, true);
  });
});
