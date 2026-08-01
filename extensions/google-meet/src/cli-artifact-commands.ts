import type { GoogleMeetCalendarLookupResult } from "./calendar.js";
import type { GoogleMeetCliCommandContext } from "./cli-command-context.js";
import {
  buildGoogleMeetExportManifest,
  googleMeetExportFileNames,
  renderArtifactsMarkdown,
  renderAttendanceCsv,
  renderAttendanceMarkdown,
  writeArtifactsSummary,
  writeAttendanceSummary,
  writeMeetExportBundle,
} from "./cli-export.js";
import {
  type GoogleMeetExportRequest,
  type MeetArtifactOptions,
  writeCliOutput,
  writeStdoutJson,
  writeStdoutLine,
} from "./cli-shared.js";
import { fetchGoogleMeetArtifacts, fetchGoogleMeetAttendance } from "./meet.js";
import { resolveGoogleMeetAccessToken } from "./oauth.js";

export function registerGoogleMeetArtifactCommands(context: GoogleMeetCliCommandContext): void {
  const params = context;
  const { root, resolveArtifactTokenOptions, resolveMeetingForToken } = context;

  root
    .command("artifacts")
    .description("List Meet conference records and available participant/artifact metadata")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--conference-record <name>", "Conference record name or id")
    .option("--today", "Find a Meet link on today's calendar")
    .option("--event <query>", "Find a matching calendar event with a Meet link")
    .option("--calendar <id>", "Calendar id for --today or --event", "primary")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--all-conference-records", "Fetch every conference record for --meeting")
    .option("--no-transcript-entries", "Skip structured transcript entry lookup")
    .option("--include-doc-bodies", "Export linked transcript and smart-note Google Docs text")
    .option("--format <format>", "Output format: summary or markdown", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = resolveArtifactTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const meeting = resolved.conferenceRecord
        ? resolved.meeting
        : (
            await resolveMeetingForToken({
              config: params.config,
              options,
              accessToken: token.accessToken,
              configuredMeeting: resolved.meeting,
            })
          ).meeting;
      const result = await fetchGoogleMeetArtifacts({
        accessToken: token.accessToken,
        meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
        includeTranscriptEntries: resolved.includeTranscriptEntries,
        allConferenceRecords: resolved.allConferenceRecords,
        includeDocumentBodies: resolved.includeDocumentBodies,
      });
      if (options.json) {
        await writeCliOutput(
          options,
          JSON.stringify(
            {
              ...result,
              tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
            },
            null,
            2,
          ),
        );
        return;
      }
      if (options.format === "markdown") {
        await writeCliOutput(options, renderArtifactsMarkdown(result));
        return;
      }
      if (options.format && options.format !== "summary") {
        throw new Error("Unsupported format. Expected summary or markdown.");
      }
      writeArtifactsSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("attendance")
    .description("List Meet participants and participant sessions")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--conference-record <name>", "Conference record name or id")
    .option("--today", "Find a Meet link on today's calendar")
    .option("--event <query>", "Find a matching calendar event with a Meet link")
    .option("--calendar <id>", "Calendar id for --today or --event", "primary")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--all-conference-records", "Fetch every conference record for --meeting")
    .option("--no-merge-duplicates", "Keep duplicate participant resources as separate rows")
    .option("--late-after-minutes <n>", "Mark participants late after this many minutes", "5")
    .option("--early-before-minutes <n>", "Mark early leavers before this many minutes", "5")
    .option("--format <format>", "Output format: summary, markdown, or csv", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = resolveArtifactTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const meeting = resolved.conferenceRecord
        ? resolved.meeting
        : (
            await resolveMeetingForToken({
              config: params.config,
              options,
              accessToken: token.accessToken,
              configuredMeeting: resolved.meeting,
            })
          ).meeting;
      const result = await fetchGoogleMeetAttendance({
        accessToken: token.accessToken,
        meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
        allConferenceRecords: resolved.allConferenceRecords,
        mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
        lateAfterMinutes: resolved.lateAfterMinutes,
        earlyBeforeMinutes: resolved.earlyBeforeMinutes,
      });
      if (options.json) {
        await writeCliOutput(
          options,
          JSON.stringify(
            {
              ...result,
              tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
            },
            null,
            2,
          ),
        );
        return;
      }
      if (options.format === "markdown") {
        await writeCliOutput(options, renderAttendanceMarkdown(result));
        return;
      }
      if (options.format === "csv") {
        await writeCliOutput(options, renderAttendanceCsv(result));
        return;
      }
      if (options.format && options.format !== "summary") {
        throw new Error("Unsupported format. Expected summary, markdown, or csv.");
      }
      writeAttendanceSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("export")
    .description("Write Meet artifacts, attendance, transcript, and raw JSON into a folder")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--conference-record <name>", "Conference record name or id")
    .option("--today", "Find a Meet link on today's calendar")
    .option("--event <query>", "Find a matching calendar event with a Meet link")
    .option("--calendar <id>", "Calendar id for --today or --event", "primary")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--all-conference-records", "Fetch every conference record for --meeting")
    .option("--no-transcript-entries", "Skip structured transcript entry lookup")
    .option("--include-doc-bodies", "Export linked transcript and smart-note Google Docs text")
    .option("--no-merge-duplicates", "Keep duplicate participant resources as separate rows")
    .option("--late-after-minutes <n>", "Mark participants late after this many minutes", "5")
    .option("--early-before-minutes <n>", "Mark early leavers before this many minutes", "5")
    .option("--output <dir>", "Output directory")
    .option("--zip", "Also write a portable .zip archive")
    .option("--dry-run", "Fetch export data and print the manifest without writing files", false)
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = resolveArtifactTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const meetingResult: { meeting?: string; calendarEvent?: GoogleMeetCalendarLookupResult } =
        resolved.conferenceRecord
          ? { meeting: resolved.meeting }
          : await resolveMeetingForToken({
              config: params.config,
              options,
              accessToken: token.accessToken,
              configuredMeeting: resolved.meeting,
            });
      const artifacts = await fetchGoogleMeetArtifacts({
        accessToken: token.accessToken,
        meeting: meetingResult.meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
        includeTranscriptEntries: resolved.includeTranscriptEntries,
        allConferenceRecords: resolved.allConferenceRecords,
        includeDocumentBodies: resolved.includeDocumentBodies,
      });
      const attendance = await fetchGoogleMeetAttendance({
        accessToken: token.accessToken,
        meeting: meetingResult.meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
        allConferenceRecords: resolved.allConferenceRecords,
        mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
        lateAfterMinutes: resolved.lateAfterMinutes,
        earlyBeforeMinutes: resolved.earlyBeforeMinutes,
      });
      const resolvedMeeting = meetingResult.meeting ?? resolved.meeting;
      const request: GoogleMeetExportRequest = {
        ...(resolvedMeeting ? { meeting: resolvedMeeting } : {}),
        ...(resolved.conferenceRecord ? { conferenceRecord: resolved.conferenceRecord } : {}),
        ...(meetingResult.calendarEvent?.event.id
          ? { calendarEventId: meetingResult.calendarEvent.event.id }
          : {}),
        ...(meetingResult.calendarEvent?.event.summary
          ? { calendarEventSummary: meetingResult.calendarEvent.event.summary }
          : {}),
        ...(options.calendar ? { calendarId: options.calendar } : {}),
        ...(resolved.pageSize !== undefined ? { pageSize: resolved.pageSize } : {}),
        includeTranscriptEntries: resolved.includeTranscriptEntries,
        includeDocumentBodies: resolved.includeDocumentBodies,
        allConferenceRecords: resolved.allConferenceRecords,
        mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
        ...(resolved.lateAfterMinutes !== undefined
          ? { lateAfterMinutes: resolved.lateAfterMinutes }
          : {}),
        ...(resolved.earlyBeforeMinutes !== undefined
          ? { earlyBeforeMinutes: resolved.earlyBeforeMinutes }
          : {}),
      };
      if (options.dryRun) {
        writeStdoutJson({
          dryRun: true,
          manifest: buildGoogleMeetExportManifest({
            artifacts,
            attendance,
            files: googleMeetExportFileNames(),
            request,
            tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
            ...(meetingResult.calendarEvent ? { calendarEvent: meetingResult.calendarEvent } : {}),
          }),
          ...(meetingResult.calendarEvent ? { calendarEvent: meetingResult.calendarEvent } : {}),
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
        });
        return;
      }
      const bundle = await writeMeetExportBundle({
        outputDir: options.output,
        artifacts,
        attendance,
        zip: Boolean(options.zip),
        request,
        tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
        ...(meetingResult.calendarEvent ? { calendarEvent: meetingResult.calendarEvent } : {}),
      });
      const payload = {
        ...bundle,
        ...(meetingResult.calendarEvent ? { calendarEvent: meetingResult.calendarEvent } : {}),
        tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
      };
      if (options.json) {
        writeStdoutJson(payload);
        return;
      }
      writeStdoutLine("export: %s", bundle.outputDir);
      for (const file of bundle.files) {
        writeStdoutLine("- %s", file);
      }
      if (bundle.zipFile) {
        writeStdoutLine("zip: %s", bundle.zipFile);
      }
    });
}
