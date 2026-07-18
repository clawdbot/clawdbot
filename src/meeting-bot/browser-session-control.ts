import { asMeetingBrowserTabs } from "./browser-request.js";
import type { MeetingBrowserRequestCaller, MeetingPlatformAdapter } from "./platform-adapter.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

type BrowserAdapter<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
> = Pick<MeetingPlatformAdapter<Session, Mode, Health, Transcript>, "browser" | "browserLabel">;

async function leaveMeetingInPage<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(params: {
  adapter: BrowserAdapter<Session, Mode, Health, Transcript>;
  callBrowser: MeetingBrowserRequestCaller;
  meetingUrl: string;
  targetId: string;
  timeoutMs: number;
}): Promise<{
  departed: boolean;
  clickedLeave: boolean;
  clickedConfirmation: boolean;
  urlMatched?: boolean;
}> {
  const deadline = Date.now() + params.timeoutMs;
  let clickedLeave = false;
  let clickedConfirmation = false;
  do {
    const evaluated = await params.callBrowser({
      method: "POST",
      path: "/act",
      body: {
        kind: "evaluate",
        targetId: params.targetId,
        fn: params.adapter.browser.buildLeaveScript(params.meetingUrl),
      },
      timeoutMs: params.timeoutMs,
    });
    const step = params.adapter.browser.parseLeaveResult(evaluated);
    clickedLeave ||= step.leaveAction === "leave";
    clickedConfirmation ||= step.leaveAction === "confirm";
    if (step.departed || step.urlMatched !== true) {
      return {
        departed: step.departed,
        clickedLeave,
        clickedConfirmation,
        urlMatched: step.urlMatched,
      };
    }
    if (!step.leaveAction && !clickedLeave) {
      return { departed: false, clickedLeave, clickedConfirmation, urlMatched: true };
    }
    if (!step.leaveAction) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  } while (Date.now() < deadline);
  return { departed: false, clickedLeave, clickedConfirmation, urlMatched: true };
}

// Leaving acts on the persisted tab identity. Reused tabs remain user-owned;
// plugin-opened tabs close only after the adapter's page-level leave attempt.
export async function leaveMeetingWithBrowser<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(params: {
  adapter: BrowserAdapter<Session, Mode, Health, Transcript>;
  callBrowser: MeetingBrowserRequestCaller;
  launch: boolean;
  meetingUrl: string;
  tab: MeetingBrowserTab;
  timeoutMs: number;
}): Promise<{ left: boolean; note: string }> {
  if (!params.launch) {
    return {
      left: false,
      note: "Browser leave skipped because chrome.launch is disabled.",
    };
  }
  const timeoutMs = Math.min(Math.max(1_000, params.timeoutMs), 5_000);
  const { targetId, openedByPlugin } = params.tab;
  try {
    const tabs = asMeetingBrowserTabs(
      await params.callBrowser({ method: "GET", path: "/tabs", timeoutMs }),
    );
    const currentTab = tabs.find((entry) => entry.targetId === targetId);
    if (!currentTab) {
      return {
        left: true,
        note: `${params.adapter.browserLabel} tab is already closed.`,
      };
    }
    let leaveResult: Awaited<ReturnType<typeof leaveMeetingInPage>>;
    try {
      leaveResult = await leaveMeetingInPage({
        adapter: params.adapter,
        callBrowser: params.callBrowser,
        meetingUrl: params.meetingUrl,
        targetId,
        timeoutMs,
      });
    } catch (error) {
      return {
        left: false,
        note: `Browser control could not verify the ${params.adapter.browserLabel} tab before leaving: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (leaveResult.urlMatched === false) {
      return {
        left: true,
        note: `${params.adapter.browserLabel} tab moved away from this session; left its current page untouched.`,
      };
    }
    if (leaveResult.urlMatched !== true) {
      return {
        left: false,
        note: "Browser control could not verify that the tracked tab still showed this meeting.",
      };
    }
    const { clickedLeave, departed } = leaveResult;
    if (!openedByPlugin) {
      return {
        left: departed,
        note: departed
          ? `Clicked ${params.adapter.browserLabel}'s Leave call button; kept the reused browser tab open.`
          : clickedLeave
            ? `Clicked ${params.adapter.browserLabel}'s Leave call button, but could not verify departure; leave it manually.`
            : `Could not find ${params.adapter.browserLabel}'s Leave call button in the reused browser tab; leave it manually.`,
      };
    }
    await params.callBrowser({
      method: "DELETE",
      path: `/tabs/${targetId}`,
      timeoutMs,
    });
    return {
      left: true,
      note: clickedLeave
        ? `Clicked ${params.adapter.browserLabel}'s Leave call button and closed the ${params.adapter.browserLabel} tab.`
        : `Closed the ${params.adapter.browserLabel} tab to leave the meeting (Leave call button was not found).`,
    };
  } catch (error) {
    return {
      left: false,
      note: `Browser control could not leave the ${params.adapter.browserLabel} tab: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function readMeetingTranscriptWithBrowser<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(params: {
  adapter: BrowserAdapter<Session, Mode, Health, Transcript>;
  callBrowser: MeetingBrowserRequestCaller;
  finalize: boolean;
  meetingUrl: string;
  meetingSessionId: string;
  tab: MeetingBrowserTab;
  timeoutMs: number;
}): Promise<Transcript> {
  const result = await params.callBrowser({
    method: "POST",
    path: "/act",
    body: {
      kind: "evaluate",
      targetId: params.tab.targetId,
      fn: params.adapter.browser.captions.buildTranscriptScript({
        finalize: params.finalize,
        meetingSessionId: params.meetingSessionId,
        meetingUrl: params.meetingUrl,
      }),
    },
    timeoutMs: params.timeoutMs,
  });
  const snapshot = params.adapter.browser.captions.parseTranscript(result);
  if (snapshot.urlMatched === false) {
    throw new Error(
      `The tracked ${params.adapter.browserLabel} tab no longer shows this session's meeting URL.`,
    );
  }
  if (snapshot.sessionMatched === false) {
    throw new Error(
      `The tracked ${params.adapter.browserLabel} tab now belongs to another OpenClaw meeting session.`,
    );
  }
  return {
    droppedLines: snapshot.droppedLines,
    ...(snapshot.epoch ? { epoch: snapshot.epoch } : {}),
    lines: snapshot.lines,
  } as Transcript;
}
