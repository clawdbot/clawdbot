import { describe, expect, it, vi } from "vitest";
import { runMeetingBrowserAct } from "./browser-act-lock.js";
import { leaveMeetingWithBrowser } from "./browser-session-control.js";

describe("meeting browser leave ownership", () => {
  async function leaveWithStep(
    step: {
      departed: boolean;
      sessionConflict?: boolean;
      sessionMatched?: boolean;
      urlMatched?: boolean;
    },
    openedByPlugin = true,
  ) {
    const buildLeaveScript = vi.fn(() => "() => '{}'");
    const deletedTabs: string[] = [];
    const result = await leaveMeetingWithBrowser({
      adapter: {
        browserLabel: "Test meeting",
        browser: {
          buildLeaveScript,
          parseLeaveResult: () => step,
        },
      } as never,
      callBrowser: async (request) => {
        if (request.path === "/tabs") {
          return { tabs: [{ targetId: "target-1", url: "https://meet.test/meeting" }] };
        }
        if (request.path === "/act") {
          return { result: "{}" };
        }
        if (request.method === "DELETE") {
          deletedTabs.push(request.path);
          return {};
        }
        throw new Error(`Unexpected browser request: ${request.method} ${request.path}`);
      },
      launch: true,
      meetingSessionId: "session-1",
      meetingUrl: "https://meet.test/meeting",
      tab: { targetId: "target-1", openedByPlugin },
      timeoutMs: 1_000,
    });
    expect(buildLeaveScript).toHaveBeenCalledWith("https://meet.test/meeting");
    expect(deletedTabs).toEqual([]);
    return result;
  }

  it("does not close a tab whose page belongs to another session", async () => {
    const result = await leaveWithStep({
      departed: false,
      sessionConflict: true,
      sessionMatched: false,
      urlMatched: true,
    });

    expect(result).toEqual({
      left: true,
      note: "Test meeting tab belongs to another OpenClaw meeting session; left its current call untouched.",
    });
  });

  it("does not report success when page ownership is unverified", async () => {
    const result = await leaveWithStep({
      departed: false,
      sessionMatched: false,
      urlMatched: true,
    });

    expect(result).toEqual({
      left: false,
      note: "Browser control could not verify that the Test meeting tab still belongs to this OpenClaw meeting session.",
    });
  });

  it("reports departure while keeping a reused tab open", async () => {
    const result = await leaveWithStep({ departed: true, urlMatched: true }, false);

    expect(result).toEqual({
      left: true,
      note: "Clicked Test meeting's Leave call button; kept the reused browser tab open.",
    });
  });

  it("carries initiated-leave evidence into the next page evaluation", async () => {
    const leaveInitiated: boolean[] = [];
    let evaluation = 0;
    const deletedTabs: string[] = [];
    let markDeleteStarted: (() => void) | undefined;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    let releaseDelete: (() => void) | undefined;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const leaving = leaveMeetingWithBrowser({
      adapter: {
        browserLabel: "Test meeting",
        browser: {
          buildLeaveScript: () => "() => '{}'",
          buildSessionLeaveScript: (context: { leaveInitiated: boolean }) => {
            leaveInitiated.push(context.leaveInitiated);
            return "() => '{}'";
          },
          parseLeaveResult: () =>
            evaluation === 1
              ? { departed: false, leaveAction: "leave", urlMatched: true }
              : evaluation === 2
                ? { departed: false, sessionMatched: false, urlMatched: true }
                : { departed: true, urlMatched: false },
        },
      } as never,
      callBrowser: async (request) => {
        if (request.path === "/tabs") {
          return { tabs: [{ targetId: "target-1", url: "https://meet.test/meeting" }] };
        }
        if (request.path === "/act") {
          evaluation += 1;
          return { result: "{}" };
        }
        if (request.method === "DELETE") {
          deletedTabs.push(request.path);
          markDeleteStarted?.();
          await deleteGate;
          return {};
        }
        throw new Error(`Unexpected browser request: ${request.method} ${request.path}`);
      },
      launch: true,
      meetingSessionId: "session-1",
      meetingUrl: "https://meet.test/meeting",
      tab: { targetId: "target-1", openedByPlugin: true },
      timeoutMs: 1_000,
    });

    await deleteStarted;
    let concurrentStarted = false;
    const concurrent = runMeetingBrowserAct({
      deadline: Date.now() + 1_000,
      targetId: "target-1",
      operation: async () => {
        concurrentStarted = true;
      },
    });
    await Promise.resolve();
    expect(concurrentStarted).toBe(false);
    releaseDelete?.();
    const result = await leaving;
    await concurrent;
    expect(leaveInitiated).toEqual([false, true, true]);
    expect(deletedTabs).toEqual(["/tabs/target-1"]);
    expect(concurrentStarted).toBe(true);
    expect(result.left).toBe(true);
  });

  it("reserves enough time to close a plugin tab after leave polling expires", async () => {
    vi.useFakeTimers();
    try {
      let evaluation = 0;
      const deletedTabs: string[] = [];
      const leaving = leaveMeetingWithBrowser({
        adapter: {
          browserLabel: "Test meeting",
          browser: {
            buildLeaveScript: () => "() => '{}'",
            parseLeaveResult: () =>
              evaluation === 1
                ? { departed: false, leaveAction: "leave", urlMatched: true }
                : { departed: false, urlMatched: true },
          },
        } as never,
        callBrowser: async (request) => {
          if (request.path === "/tabs") {
            return { tabs: [{ targetId: "target-1", url: "https://meet.test/meeting" }] };
          }
          if (request.path === "/act") {
            evaluation += 1;
            return { result: "{}" };
          }
          if (request.method === "DELETE") {
            deletedTabs.push(request.path);
            return {};
          }
          throw new Error(`Unexpected browser request: ${request.method} ${request.path}`);
        },
        launch: true,
        meetingSessionId: "session-1",
        meetingUrl: "https://meet.test/meeting",
        tab: { targetId: "target-1", openedByPlugin: true },
        timeoutMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await leaving;
      expect(evaluation).toBeGreaterThan(1);
      expect(deletedTabs).toEqual(["/tabs/target-1"]);
      expect(result).toEqual({
        left: true,
        note: "Clicked Test meeting's Leave call button and closed the Test meeting tab.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
