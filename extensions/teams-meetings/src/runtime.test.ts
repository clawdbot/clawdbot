import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveTeamsMeetingsConfig } from "./config.js";
import { TeamsMeetingsRuntime } from "./runtime.js";

const URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_runtime%40thread.v2/0?context=%7b%22Tid%22%3a%22one%22%7d";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function runtimeHarness(options?: { tabOpen?: boolean }) {
  let tabOpen = options?.tabOpen ?? false;
  let targetId = "teams-tab";
  let tabUrl = URL;
  const gatewayRequest = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.path === "/tabs") {
      return {
        tabs: tabOpen ? [{ targetId, title: "Teams call", url: tabUrl }] : [],
      };
    }
    if (params.path === "/tabs/open") {
      tabOpen = true;
      tabUrl = URL;
      return { targetId, title: "Teams call", url: tabUrl };
    }
    if (params.path === "/tabs/focus") {
      return { ok: true };
    }
    if (params.path === "/act") {
      const rawFn = (params.body as { fn?: unknown } | undefined)?.fn;
      const fn = typeof rawFn === "string" ? rawFn : "";
      if (fn.includes("expectedSessionId")) {
        return {
          result: JSON.stringify({
            urlMatched: true,
            sessionMatched: true,
            droppedLines: 0,
            lines: [],
          }),
        };
      }
      if (fn.includes("leaveAction")) {
        return { result: JSON.stringify({ departed: true, urlMatched: true }) };
      }
      return {
        result: JSON.stringify({
          inCall: true,
          micMuted: true,
          cameraOff: true,
          url: tabUrl,
          title: "Teams call",
        }),
      };
    }
    if (params.method === "DELETE" && params.path === `/tabs/${targetId}`) {
      tabOpen = false;
      return { ok: true };
    }
    throw new Error(`unexpected browser request ${String(params.method)} ${String(params.path)}`);
  });
  const runtime = {
    gateway: {
      isAvailable: vi.fn(async () => true),
      request: gatewayRequest,
    },
    system: {
      runCommandWithTimeout: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    },
  } as unknown as PluginRuntime;
  return {
    runtime,
    gatewayRequest,
    setTargetId(value: string) {
      targetId = value;
    },
    setTabUrl(value: string) {
      tabUrl = value;
    },
  };
}

describe("Microsoft Teams meeting session flow", () => {
  it("joins, reuses, reports, snapshots, speaks safely, and leaves through core", async () => {
    const harness = runtimeHarness();
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });

    const first = await runtime.join({ url: URL, mode: "transcribe" });
    expect(first.session.chrome?.health).toMatchObject({ inCall: true, cameraOff: true });

    const reused = await runtime.join({
      url: `${URL.split("?")[0]}?context=%7b%22Tid%22%3a%22two%22%7d`,
      mode: "transcribe",
    });
    expect(reused.session.id).toBe(first.session.id);
    expect(runtime.list()).toHaveLength(1);

    expect(await runtime.status(first.session.id)).toMatchObject({
      found: true,
      session: { id: first.session.id },
    });
    expect(await runtime.transcript(first.session.id)).toMatchObject({
      found: true,
      lines: [],
      nextIndex: 0,
    });
    expect(await runtime.speak(first.session.id, "hello")).toMatchObject({
      found: true,
      spoken: false,
    });
    expect(await runtime.leave(first.session.id)).toMatchObject({
      found: true,
      browserLeft: true,
      session: { state: "ended" },
    });
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open" }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("recovers and leaves a manually opened tab when Chrome launching is disabled", async () => {
    const harness = runtimeHarness({ tabOpen: true });
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { launch: false, waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });

    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    expect(joined.session.chrome).toMatchObject({
      browserTab: { openedByPlugin: false, targetId: "teams-tab" },
      launched: false,
    });
    expect(harness.gatewayRequest).not.toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open" }),
      expect.anything(),
    );
    expect(await runtime.leave(joined.session.id)).toMatchObject({
      browserLeft: true,
      session: { state: "ended" },
    });
  });

  it("refreshes a recovered browser tab target", async () => {
    const harness = runtimeHarness();
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setTargetId("teams-tab-replaced");

    await runtime.status(joined.session.id);

    expect(joined.session.chrome?.browserTab).toEqual({
      openedByPlugin: false,
      targetId: "teams-tab-replaced",
    });
  });

  it("recovers the tracked tab after Teams rewrites the in-call URL", async () => {
    const harness = runtimeHarness();
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setTabUrl("https://teams.microsoft.com/v2/");
    harness.gatewayRequest.mockClear();

    const status = await runtime.status(joined.session.id);

    expect(status.session?.chrome?.health?.browserUrl).toBe("https://teams.microsoft.com/v2/");
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/act",
        body: expect.objectContaining({ targetId: "teams-tab" }),
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });
});
