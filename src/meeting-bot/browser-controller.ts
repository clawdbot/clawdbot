import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { runMeetingBrowserAct } from "./browser-act-lock.js";
import { isMeetingBrowserTransientNavigationError } from "./browser-navigation-errors.js";
import { asMeetingBrowserTabs, readMeetingBrowserTab } from "./browser-request.js";
import type {
  MeetingBrowserJoinSession,
  MeetingManualAction,
  MeetingBrowserRequestCaller,
  MeetingPlatformAdapter,
} from "./platform-adapter.js";
import type {
  MeetingBrowserCandidateTab,
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

export type MeetingBrowserControllerConfig = {
  launch: boolean;
  reuseExistingTab: boolean;
  autoJoin: boolean;
  guestName: string;
  joinTimeoutMs: number;
  waitForInCallMs: number;
};

type BrowserAdapter<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
> = Pick<
  MeetingPlatformAdapter<Session, Mode, Health, Transcript>,
  "browser" | "browserLabel" | "urls"
>;

function mergeBrowserNotes<Health extends MeetingBrowserHealth & { notes?: string[] }>(
  browser: Health | undefined,
  notes: string[],
): Health | undefined {
  if (!browser || notes.length === 0) {
    return browser;
  }
  return {
    ...browser,
    notes: uniqueStrings([...(browser.notes ?? []), ...notes]),
  };
}

function applyMeetingManualAction<Health extends MeetingBrowserHealth>(
  browser: Health | undefined,
  manual: MeetingManualAction | undefined,
): Health | undefined {
  return browser && manual
    ? {
        ...browser,
        manualActionRequired: true,
        manualActionReason: manual.reason,
        manualActionMessage: manual.message,
      }
    : browser;
}

async function prepareMeetingBrowserTab<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(params: {
  adapter: BrowserAdapter<Session, Mode, Health, Transcript>;
  allowMicrophone: boolean;
  callBrowser: MeetingBrowserRequestCaller;
  meetingUrl: string;
  targetId: string;
  timeoutMs: number;
}): Promise<string[]> {
  const plan = params.adapter.browser.permissions({
    allowMicrophone: params.allowMicrophone,
    meetingUrl: params.meetingUrl,
  });
  if (!plan) {
    return params.adapter.browser.permissionNotes({
      allowMicrophone: params.allowMicrophone,
    });
  }
  try {
    const result = await params.callBrowser({
      method: "POST",
      path: "/permissions/grant",
      body: {
        origin: plan.origin,
        permissions: plan.permissions,
        optionalPermissions: plan.optionalPermissions,
        targetId: params.targetId,
        timeoutMs: Math.min(params.timeoutMs, 5_000),
      },
      timeoutMs: Math.min(params.timeoutMs, 5_000),
    });
    return params.adapter.browser.permissionNotes({
      allowMicrophone: params.allowMicrophone,
      result,
    });
  } catch (error) {
    return params.adapter.browser.permissionNotes({
      allowMicrophone: params.allowMicrophone,
      error,
    });
  }
}

function selectReusableTab<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(params: {
  adapter: BrowserAdapter<Session, Mode, Health, Transcript>;
  tabs: MeetingBrowserCandidateTab[];
  url: string;
}) {
  const matches = params.tabs.filter((tab) =>
    params.adapter.urls.isRecoverableTab(tab, params.url),
  );
  const accountHint = params.adapter.urls.accountHint(params.url);
  const tab = matches.find(
    (candidate) =>
      params.adapter.urls.isPreferredJoinUrl(candidate.url) &&
      (!accountHint || params.adapter.urls.accountHint(candidate.url) === accountHint),
  );
  return { matches, tab };
}

export async function openMeetingWithBrowser<
  Session extends MeetingBrowserJoinSession<Mode>,
  Mode extends string,
  Health extends MeetingBrowserHealth & {
    browserTitle?: string;
    browserUrl?: string;
    notes?: string[];
  },
  Transcript extends MeetingTranscriptSnapshot,
>(params: {
  adapter: BrowserAdapter<Session, Mode, Health, Transcript>;
  callBrowser: MeetingBrowserRequestCaller;
  config: MeetingBrowserControllerConfig;
  session: Session;
}): Promise<{ launched: boolean; browser?: Health; tab?: MeetingBrowserTab }> {
  if (!params.config.launch) {
    return { launched: false };
  }

  const timeoutMs = Math.max(1_000, params.config.joinTimeoutMs);
  let targetId: string | undefined;
  let tab: MeetingBrowserCandidateTab | undefined;
  let openSession = params.session;
  let openedByPlugin = false;
  if (params.config.reuseExistingTab) {
    const tabs = asMeetingBrowserTabs(
      await params.callBrowser({
        method: "GET",
        path: "/tabs",
        timeoutMs: Math.min(timeoutMs, 5_000),
      }),
    );
    const reusable = selectReusableTab({
      adapter: params.adapter,
      tabs,
      url: params.session.url,
    });
    tab = reusable.tab;
    if (!tab && !params.adapter.urls.accountHint(params.session.url)) {
      const fallbackUrl = reusable.matches.find((candidate) => candidate.url)?.url;
      if (fallbackUrl) {
        openSession = { ...params.session, url: fallbackUrl };
      }
    }
    targetId = tab?.targetId;
    if (tab && targetId) {
      await params.callBrowser({
        method: "POST",
        path: "/tabs/focus",
        body: { targetId },
        timeoutMs: Math.min(timeoutMs, 5_000),
      });
    }
  }
  if (!targetId) {
    tab = readMeetingBrowserTab(
      await params.callBrowser({
        method: "POST",
        path: "/tabs/open",
        body: { url: params.adapter.urls.buildJoinUrl(openSession) },
        timeoutMs,
      }),
    );
    targetId = tab?.targetId;
    openedByPlugin = Boolean(targetId);
  }
  if (!targetId) {
    return {
      launched: true,
      browser: {
        status: "browser-control",
        notes: [
          `Browser proxy opened ${params.adapter.browserLabel} but did not return a targetId.`,
        ],
        browserUrl: tab?.url,
        browserTitle: tab?.title,
      } as unknown as Health,
    };
  }

  const tabIdentity: MeetingBrowserTab = { targetId, openedByPlugin };
  const allowMicrophone = params.adapter.browser.allowsMicrophone(params.session.mode);
  const permissionNotes = await prepareMeetingBrowserTab({
    adapter: params.adapter,
    allowMicrophone,
    callBrowser: params.callBrowser,
    meetingUrl: params.session.url,
    targetId,
    timeoutMs,
  });
  const deadline = Date.now() + Math.max(0, params.config.waitForInCallMs);
  let browser: Health | undefined = {
    status: "browser-control",
    browserUrl: tab?.url,
    browserTitle: tab?.title,
    notes: permissionNotes,
  } as unknown as Health;
  let allowSessionAdoption = true;
  do {
    try {
      const adoptSession = allowSessionAdoption;
      allowSessionAdoption = false;
      const actionTimeoutMs = Math.min(timeoutMs, 10_000);
      const evaluated = await runMeetingBrowserAct({
        deadline: Date.now() + actionTimeoutMs,
        targetId,
        operation: async (remainingMs) =>
          await params.callBrowser({
            method: "POST",
            path: "/act",
            body: {
              kind: "evaluate",
              targetId,
              fn: params.adapter.browser.buildStatusJoinScript({
                ...params.session,
                allowSessionAdoption: adoptSession,
                autoJoin: params.config.autoJoin,
                captureCaptions: params.adapter.browser.captions.enabled(params.session.mode),
                guestName: params.config.guestName,
                waitForInCallMs: params.config.waitForInCallMs,
              }),
            },
            timeoutMs: remainingMs,
          }),
      });
      browser = mergeBrowserNotes(
        params.adapter.browser.parseStatus(evaluated) ?? browser,
        permissionNotes,
      );
      const manual: MeetingManualAction | undefined = browser
        ? params.adapter.browser.classifyManualAction(browser)
        : undefined;
      browser = applyMeetingManualAction(browser, manual);
      // Some web clients render their in-call media controls after admission. Let the
      // platform retry those transient states before treating them as user action.
      const shouldRetry = browser
        ? params.adapter.browser.shouldRetryJoinStatus?.(browser) === true
        : false;
      if (
        !shouldRetry &&
        browser?.inCall === true &&
        browser.manualActionRequired !== true &&
        (!allowMicrophone || browser.micMuted !== true)
      ) {
        return { launched: true, browser, tab: tabIdentity };
      }
      if (!shouldRetry && browser?.manualActionRequired === true) {
        return { launched: true, browser, tab: tabIdentity };
      }
    } catch (error) {
      if (isMeetingBrowserTransientNavigationError(error) && Date.now() < deadline) {
        browser = mergeBrowserNotes(browser, [
          `${params.adapter.browserLabel} navigated while joining; retrying browser inspection.`,
        ]);
      } else {
        const manual = params.adapter.browser.browserControlUnavailable(error);
        browser = {
          ...browser,
          inCall: false,
          manualActionRequired: true,
          manualActionReason: manual.reason,
          manualActionMessage: manual.message,
          notes: [
            ...permissionNotes,
            `Browser control could not inspect or auto-join ${params.adapter.browserLabel}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ],
        } as unknown as Health;
        break;
      }
    }
    const remainingWaitMs = deadline - Date.now();
    if (remainingWaitMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(750, remainingWaitMs));
      });
    }
  } while (Date.now() < deadline);
  return { launched: true, browser, tab: tabIdentity };
}

function findRecoverableTab<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(params: {
  adapter: BrowserAdapter<Session, Mode, Health, Transcript>;
  tabs: MeetingBrowserCandidateTab[];
  requestedMeetingUrl: string | undefined;
}): MeetingBrowserCandidateTab | undefined {
  const candidates = params.tabs.filter((tab) =>
    params.adapter.urls.isRecoverableTab(tab, params.requestedMeetingUrl),
  );
  if (!params.requestedMeetingUrl) {
    // Untargeted recovery also admits login fallbacks. Prefer a real meeting
    // identity so browser enumeration order cannot select a sign-in tab first.
    const meetingCandidates = candidates.filter((tab) =>
      params.adapter.urls.normalizeForReuse(tab.url),
    );
    return (
      meetingCandidates.find((tab) => params.adapter.urls.isPreferredJoinUrl(tab.url)) ??
      meetingCandidates[0] ??
      candidates[0]
    );
  }
  const accountHint = params.adapter.urls.accountHint(params.requestedMeetingUrl);
  const accountCandidates = accountHint
    ? candidates.filter((tab) => params.adapter.urls.accountHint(tab.url) === accountHint)
    : candidates;
  return (
    accountCandidates.find((tab) => params.adapter.urls.isPreferredJoinUrl(tab.url)) ??
    accountCandidates[0]
  );
}

async function inspectRecoverableTab<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth & {
    browserTitle?: string;
    browserUrl?: string;
    notes?: string[];
  },
  Transcript extends MeetingTranscriptSnapshot,
>(params: {
  adapter: BrowserAdapter<Session, Mode, Health, Transcript>;
  allowSessionAdoption?: boolean;
  autoJoin?: boolean;
  callBrowser: MeetingBrowserRequestCaller;
  config: MeetingBrowserControllerConfig;
  meetingSessionId?: string;
  mode: Mode;
  readOnly?: boolean;
  requestedMeetingUrl: string | undefined;
  tab: MeetingBrowserCandidateTab;
  targetId: string;
  deadline?: number;
  timeoutMs: number;
}) {
  const allowMicrophone = params.adapter.browser.allowsMicrophone(params.mode);
  const focusTimeoutMs =
    params.deadline === undefined ? params.timeoutMs : Math.floor(params.deadline - Date.now());
  if (focusTimeoutMs <= 0) {
    throw new Error("Meeting browser recovery timed out.");
  }
  await params.callBrowser({
    method: "POST",
    path: "/tabs/focus",
    body: { targetId: params.targetId },
    timeoutMs: Math.min(focusTimeoutMs, 5_000),
  });
  const localeAction = params.adapter.urls.localeAction(params.tab);
  if (localeAction) {
    return {
      found: true,
      targetId: params.targetId,
      tab: params.tab,
      browser: {
        status: "browser-control",
        browserUrl: params.tab.url,
        browserTitle: params.tab.title,
        manualActionRequired: true,
        manualActionReason: localeAction.reason,
        manualActionMessage: localeAction.message,
      } as unknown as Health,
      message: localeAction.message,
    };
  }
  const permissionNotes = params.readOnly
    ? []
    : await prepareMeetingBrowserTab({
        adapter: params.adapter,
        allowMicrophone,
        callBrowser: params.callBrowser,
        meetingUrl: params.requestedMeetingUrl ?? params.tab.url ?? "",
        targetId: params.targetId,
        timeoutMs:
          params.deadline === undefined
            ? params.timeoutMs
            : Math.max(1, Math.floor(params.deadline - Date.now())),
      });
  const navigationNotes: string[] = [];
  const inspectionDeadline = params.deadline ?? Date.now() + Math.min(params.timeoutMs, 10_000);
  let allowSessionAdoption = params.allowSessionAdoption ?? false;
  let evaluated: unknown;
  for (;;) {
    try {
      const adoptSession = allowSessionAdoption;
      allowSessionAdoption = false;
      evaluated = await runMeetingBrowserAct({
        deadline: inspectionDeadline,
        targetId: params.targetId,
        operation: async (remainingMs) =>
          await params.callBrowser({
            method: "POST",
            path: "/act",
            body: {
              kind: "evaluate",
              targetId: params.targetId,
              fn: params.adapter.browser.buildStatusJoinScript({
                allowSessionAdoption: adoptSession,
                meetingSessionId: params.meetingSessionId ?? "",
                mode: params.mode,
                url: params.requestedMeetingUrl ?? params.tab.url ?? "",
                autoJoin: params.autoJoin ?? false,
                captureCaptions: params.adapter.browser.captions.enabled(params.mode),
                guestName: params.config.guestName,
                readOnly: params.readOnly,
                waitForInCallMs: params.config.waitForInCallMs,
              }),
            },
            timeoutMs: remainingMs,
          }),
      });
      break;
    } catch (error) {
      const remainingMs = inspectionDeadline - Date.now();
      if (!isMeetingBrowserTransientNavigationError(error) || remainingMs <= 0) {
        throw error;
      }
      navigationNotes.push(
        `${params.adapter.browserLabel} navigated while recovering; retrying browser inspection.`,
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(250, remainingMs));
      });
      if (Date.now() >= inspectionDeadline) {
        throw error;
      }
    }
  }
  const browser = mergeBrowserNotes(
    params.adapter.browser.parseStatus(evaluated) ??
      ({
        status: "browser-control",
        browserUrl: params.tab.url,
        browserTitle: params.tab.title,
      } as unknown as Health),
    [...permissionNotes, ...navigationNotes],
  );
  const manual: MeetingManualAction | undefined = browser
    ? params.adapter.browser.classifyManualAction(browser)
    : undefined;
  const recoveredBrowser = applyMeetingManualAction(browser, manual);
  const message =
    manual?.message ??
    (recoveredBrowser?.inCall
      ? `Existing ${params.adapter.browserLabel} tab is in-call.`
      : `Existing ${params.adapter.browserLabel} tab focused.`);
  return {
    found: true,
    targetId: params.targetId,
    tab: params.tab,
    browser: recoveredBrowser,
    message,
  };
}

export async function recoverMeetingBrowserTab<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth & {
    browserTitle?: string;
    browserUrl?: string;
    notes?: string[];
  },
  Transcript extends MeetingTranscriptSnapshot,
>(params: {
  adapter: BrowserAdapter<Session, Mode, Health, Transcript>;
  allowSessionAdoption?: boolean;
  autoJoin?: boolean;
  callBrowser: MeetingBrowserRequestCaller;
  config: MeetingBrowserControllerConfig;
  locationLabel: string;
  meetingSessionId?: string;
  mode: Mode;
  requestedMeetingUrl: string | undefined;
  readOnly?: boolean;
  timeoutMs?: number;
  trackedMeetingUrl: string | undefined;
  trackedTargetId: string | undefined;
}): Promise<{
  found: boolean;
  targetId?: string;
  tab?: MeetingBrowserCandidateTab;
  browser?: Health;
  message: string;
}> {
  const configuredTimeoutMs = Math.max(1_000, params.config.joinTimeoutMs);
  const timeoutMs =
    params.timeoutMs === undefined
      ? configuredTimeoutMs
      : Math.max(1, Math.min(configuredTimeoutMs, params.timeoutMs));
  const deadline = params.timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const tabs = asMeetingBrowserTabs(
    await params.callBrowser({
      method: "GET",
      path: "/tabs",
      timeoutMs:
        deadline === undefined
          ? Math.min(timeoutMs, 5_000)
          : Math.min(Math.max(1, Math.floor(deadline - Date.now())), 5_000),
    }),
  );
  const trackedCandidate = params.trackedTargetId
    ? tabs.find((tab) => tab.targetId === params.trackedTargetId)
    : undefined;
  const trackedUrlHasMeetingIdentity = Boolean(
    params.adapter.urls.normalizeForReuse(trackedCandidate?.url),
  );
  const trackedIdentityMatches = params.adapter.urls.isSameMeeting(
    params.trackedMeetingUrl,
    params.requestedMeetingUrl,
  );
  const trackedUrlMatches = params.adapter.urls.isSameMeeting(
    trackedCandidate?.url,
    params.requestedMeetingUrl,
  );
  // Meeting SPAs may replace the join URL after admission. Keep the persisted
  // target for non-identifying URLs, but never follow it into another meeting.
  const trackedTab =
    trackedCandidate &&
    trackedIdentityMatches &&
    (!trackedUrlHasMeetingIdentity || trackedUrlMatches)
      ? trackedCandidate
      : undefined;
  const tab =
    trackedTab ??
    findRecoverableTab({
      adapter: params.adapter,
      tabs,
      requestedMeetingUrl: params.requestedMeetingUrl,
    });
  const targetId = tab?.targetId;
  if (!tab || !targetId) {
    return {
      found: false,
      tab,
      message: params.requestedMeetingUrl
        ? `No existing ${params.adapter.browserLabel} tab matched ${params.requestedMeetingUrl}.`
        : `No existing ${params.adapter.browserLabel} tab found ${params.locationLabel}.`,
    };
  }
  return await inspectRecoverableTab({
    adapter: params.adapter,
    allowSessionAdoption: params.allowSessionAdoption,
    autoJoin: params.autoJoin,
    callBrowser: params.callBrowser,
    config: params.config,
    ...(deadline === undefined ? {} : { deadline }),
    meetingSessionId: params.meetingSessionId,
    mode: params.mode,
    readOnly: params.readOnly,
    requestedMeetingUrl: params.requestedMeetingUrl,
    timeoutMs,
    tab,
    targetId,
  });
}
