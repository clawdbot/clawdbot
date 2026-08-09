import { buildGoogleMeetCalendarDayWindow, listGoogleMeetCalendarEvents } from "./calendar.js";
import {
  addGoogleMeetCalendarOptions,
  addGoogleMeetMeetingOption,
  addGoogleMeetOAuthOptions,
  type GoogleMeetCliCommandContext,
} from "./cli-command-context.js";
import { writeCalendarEventsSummary, writeLatestConferenceRecordSummary } from "./cli-export.js";
import {
  callGoogleMeetGateway,
  parseGoogleMeetMode,
  parseGoogleMeetTransport,
  type CreateOptions,
  type JsonOptions,
  type ResolveSpaceOptions,
  writeStdoutJson,
  writeStdoutLine,
} from "./cli-shared.js";
import { hasCreateSpaceConfigInput, resolveCreateSpaceConfig } from "./create.js";
import {
  buildGoogleMeetPreflightReport,
  createGoogleMeetSpace,
  endGoogleMeetActiveConference,
  fetchLatestGoogleMeetConferenceRecord,
} from "./meet.js";
import {
  resolveGoogleMeetTokenFromParams,
  resolveMeetingFromParams,
  resolveSpaceFromParams,
} from "./plugin-helpers.js";

type GoogleMeetCreateOutput = {
  browser?: {
    nodeId?: string;
    targetId?: string;
    browserUrl?: string;
    browserTitle?: string;
  };
  joined?: boolean;
  join?: { session?: { id?: string } };
  meetingUri?: string;
  source?: string;
  space?: { name?: string; meetingCode?: string };
  tokenSource?: string;
};

function writeGoogleMeetCreateOutput(
  payload: GoogleMeetCreateOutput,
  json: boolean | undefined,
): void {
  if (json) {
    writeStdoutJson(payload);
    return;
  }
  writeStdoutLine("meeting uri: %s", payload.meetingUri);
  if (payload.space?.name) {
    writeStdoutLine("space: %s", payload.space.name);
  }
  if (payload.space?.meetingCode) {
    writeStdoutLine("meeting code: %s", payload.space.meetingCode);
  }
  if (payload.source) {
    writeStdoutLine("source: %s", payload.source);
  }
  if (payload.browser?.nodeId) {
    writeStdoutLine("node: %s", payload.browser.nodeId);
  }
  if (payload.tokenSource) {
    writeStdoutLine("token source: %s", payload.tokenSource);
  }
  const joinedSessionId = payload.joined ? payload.join?.session?.id : undefined;
  writeStdoutLine(
    joinedSessionId ? "joined: %s" : "joined: no (run `openclaw googlemeet join %s`)",
    joinedSessionId ?? payload.meetingUri,
  );
}

export function registerGoogleMeetCreateCommands(context: GoogleMeetCliCommandContext): void {
  const params = context;
  const {
    root,
    callGateway,
    operationTimeoutMs,
    hasCreateOAuth,
    resolveMeetingInput,
    resolveCliParams,
  } = context;

  addGoogleMeetOAuthOptions(
    root.command("create").description("Create a new Google Meet space and print its meeting URL"),
  )
    .option(
      "--access-type <type>",
      "Google Meet SpaceConfig accessType for API create: OPEN, TRUSTED, or RESTRICTED",
    )
    .option(
      "--entry-point-access <type>",
      "Google Meet SpaceConfig entryPointAccess for API create: ALL or CREATOR_APP_ONLY",
    )
    .option("--no-join", "Only create the meeting URL; do not join it")
    .option("--transport <transport>", "Join transport: chrome, chrome-node, or twilio")
    .option("--mode <mode>", "Join mode: agent, bidi, or transcribe")
    .option("--message <text>", "Realtime speech to trigger after join")
    .option("--dial-in-number <phone>", "Meet dial-in number for Twilio transport")
    .option("--pin <pin>", "Meet phone PIN; # is appended if omitted")
    .option("--dtmf-sequence <sequence>", "Explicit Twilio DTMF sequence")
    .option("--json", "Print JSON output", false)
    .action(async (options: CreateOptions) => {
      if (options.join !== false) {
        const delegated = await callGoogleMeetGateway({
          callGateway,
          method: "googlemeet.create",
          payload: { ...options },
          timeoutMs: operationTimeoutMs,
        });
        if (delegated.ok) {
          const payload = delegated.payload as {
            browser?: { nodeId?: string };
            joined?: boolean;
            join?: { session?: { id?: string } };
            meetingUri?: string;
            source?: string;
            space?: { name?: string; meetingCode?: string };
            tokenSource?: string;
          };
          writeGoogleMeetCreateOutput(payload, options.json);
          return;
        }
      }
      if (!hasCreateOAuth(params.config, options)) {
        if (hasCreateSpaceConfigInput(options as Record<string, unknown>)) {
          throw new Error(
            "Google Meet access policy options require OAuth/API room creation. Configure Google Meet OAuth or remove --access-type/--entry-point-access.",
          );
        }
        const rt = await params.ensureRuntime();
        const result = await rt.createViaBrowser();
        const join =
          options.join !== false
            ? await rt.join({
                url: result.meetingUri,
                transport: parseGoogleMeetTransport(options.transport),
                mode: parseGoogleMeetMode(options.mode),
                message: options.message,
                dialInNumber: options.dialInNumber,
                pin: options.pin,
                dtmfSequence: options.dtmfSequence,
              })
            : undefined;
        writeGoogleMeetCreateOutput(
          {
            source: result.source,
            meetingUri: result.meetingUri,
            joined: Boolean(join),
            ...(join ? { join } : {}),
            browser: {
              nodeId: result.nodeId,
              targetId: result.targetId,
              browserUrl: result.browserUrl,
              browserTitle: result.browserTitle,
            },
          },
          options.json,
        );
        return;
      }
      const token = await resolveGoogleMeetTokenFromParams(
        params.config,
        resolveCliParams(options),
      );
      const result = await createGoogleMeetSpace({
        accessToken: token.accessToken,
        config: resolveCreateSpaceConfig(options as Record<string, unknown>),
      });
      const join =
        options.join !== false
          ? await (
              await params.ensureRuntime()
            ).join({
              url: result.meetingUri,
              transport: parseGoogleMeetTransport(options.transport),
              mode: parseGoogleMeetMode(options.mode),
              message: options.message,
              dialInNumber: options.dialInNumber,
              pin: options.pin,
              dtmfSequence: options.dtmfSequence,
            })
          : undefined;
      writeGoogleMeetCreateOutput(
        {
          ...result,
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
          joined: Boolean(join),
          ...(join ? { join } : {}),
        },
        options.json,
      );
    });

  addGoogleMeetOAuthOptions(
    root
      .command("end-active-conference")
      .description("End the active conference for a Google Meet space")
      .argument("[meeting]", "Meet URL, meeting code, or spaces/{id}"),
  )
    .option("--json", "Print JSON output", false)
    .action(async (meeting: string | undefined, options: ResolveSpaceOptions & JsonOptions) => {
      const token = await resolveGoogleMeetTokenFromParams(
        params.config,
        resolveCliParams(options),
      );
      const result = await endGoogleMeetActiveConference({
        accessToken: token.accessToken,
        meeting: resolveMeetingInput(params.config, meeting ?? options.meeting),
      });
      if (options.json) {
        writeStdoutJson({
          ...result,
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
        });
        return;
      }
      writeStdoutLine("space: %s", result.space);
      writeStdoutLine("ended: yes");
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });
}

export function registerGoogleMeetApiCommands(context: GoogleMeetCliCommandContext): void {
  const params = context;
  const { root, resolveCliParams, resolveMeetingInput } = context;

  addGoogleMeetOAuthOptions(
    addGoogleMeetMeetingOption(
      root
        .command("resolve-space")
        .description("Resolve a Meet URL, meeting code, or spaces/{id} to its canonical space"),
    ),
  )
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const meeting = resolveMeetingInput(params.config, options.meeting);
      const { space, token } = await resolveSpaceFromParams(params.config, {
        ...resolveCliParams(options),
        meeting,
      });
      if (options.json) {
        writeStdoutJson(space);
        return;
      }
      writeStdoutLine("input: %s", meeting);
      writeStdoutLine("space: %s", space.name);
      if (space.meetingCode) {
        writeStdoutLine("meeting code: %s", space.meetingCode);
      }
      if (space.meetingUri) {
        writeStdoutLine("meeting uri: %s", space.meetingUri);
      }
      writeStdoutLine("active conference: %s", space.activeConference ? "yes" : "no");
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  addGoogleMeetOAuthOptions(
    addGoogleMeetMeetingOption(
      root
        .command("preflight")
        .description("Validate OAuth + meeting resolution prerequisites for Meet media work"),
    ),
  )
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const meeting = resolveMeetingInput(params.config, options.meeting);
      const { space, token } = await resolveSpaceFromParams(params.config, {
        ...resolveCliParams(options),
        meeting,
      });
      const report = buildGoogleMeetPreflightReport({
        input: meeting,
        space,
        previewAcknowledged: params.config.preview.enrollmentAcknowledged,
        tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
      });
      if (options.json) {
        writeStdoutJson(report);
        return;
      }
      writeStdoutLine("input: %s", report.input);
      writeStdoutLine("resolved space: %s", report.resolvedSpaceName);
      if (report.meetingCode) {
        writeStdoutLine("meeting code: %s", report.meetingCode);
      }
      if (report.meetingUri) {
        writeStdoutLine("meeting uri: %s", report.meetingUri);
      }
      writeStdoutLine("active conference: %s", report.hasActiveConference ? "yes" : "no");
      writeStdoutLine("preview acknowledged: %s", report.previewAcknowledged ? "yes" : "no");
      writeStdoutLine("token source: %s", report.tokenSource);
      if (report.blockers.length === 0) {
        writeStdoutLine("blockers: none");
        return;
      }
      writeStdoutLine("blockers:");
      for (const blocker of report.blockers) {
        writeStdoutLine("- %s", blocker);
      }
    });

  addGoogleMeetOAuthOptions(
    addGoogleMeetCalendarOptions(
      addGoogleMeetMeetingOption(
        root.command("latest").description("Find the latest Meet conference record for a meeting"),
      ),
    ),
  )
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const raw = resolveCliParams(options);
      const token = await resolveGoogleMeetTokenFromParams(params.config, raw);
      if (!options.today && !options.event?.trim()) {
        const meeting = options.meeting?.trim() || params.config.defaults.meeting;
        if (!meeting) {
          throw new Error(
            "Meeting input is required. Pass --meeting, --today, --event, or configure defaults.meeting.",
          );
        }
        raw.meeting = meeting;
      }
      const resolved = await resolveMeetingFromParams({
        config: params.config,
        raw,
        accessToken: token.accessToken,
      });
      const result = await fetchLatestGoogleMeetConferenceRecord({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
      });
      if (options.json) {
        writeStdoutJson({
          ...result,
          ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
        });
        return;
      }
      if (resolved.calendarEvent) {
        writeStdoutLine("calendar event: %s", resolved.calendarEvent.event.summary ?? "untitled");
        writeStdoutLine("calendar meet: %s", resolved.calendarEvent.meetingUri);
      }
      writeLatestConferenceRecordSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("calendar-events")
    .description("Preview Calendar events with Google Meet links")
    .option("--today", "Find Meet links on today's calendar")
    .option("--event <query>", "Find matching calendar events with Meet links")
    .option("--calendar <id>", "Calendar id for lookup", "primary")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const token = await resolveGoogleMeetTokenFromParams(
        params.config,
        resolveCliParams(options),
      );
      const window = options.today ? buildGoogleMeetCalendarDayWindow() : {};
      const result = await listGoogleMeetCalendarEvents({
        accessToken: token.accessToken,
        calendarId: options.calendar,
        eventQuery: options.event,
        ...window,
      });
      const payload = {
        ...result,
        tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
      };
      if (options.json) {
        writeStdoutJson(payload);
        return;
      }
      writeCalendarEventsSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });
}
