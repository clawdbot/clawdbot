import {
  addGoogleMeetArtifactOptions,
  type GoogleMeetCliCommandContext,
} from "./cli-command-context.js";
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
import {
  fetchResolvedGoogleMeetArtifacts,
  fetchResolvedGoogleMeetAttendance,
  resolveArtifactQueryFromParams,
} from "./plugin-helpers.js";

async function resolveCliArtifactQuery(
  context: GoogleMeetCliCommandContext,
  options: MeetArtifactOptions,
) {
  const { lateAfterMinutes, earlyBeforeMinutes, ...raw } =
    context.resolveCliArtifactParams(options);
  return {
    ...(await resolveArtifactQueryFromParams(context.config, raw)),
    lateAfterMinutes,
    earlyBeforeMinutes,
  };
}

export function registerGoogleMeetArtifactCommands(context: GoogleMeetCliCommandContext): void {
  const params = context;
  const { root } = context;

  addGoogleMeetArtifactOptions(
    root
      .command("artifacts")
      .description("List Meet conference records and available participant/artifact metadata"),
  )
    .option("--no-transcript-entries", "Skip structured transcript entry lookup")
    .option("--include-doc-bodies", "Export linked transcript and smart-note Google Docs text")
    .option("--format <format>", "Output format: summary or markdown", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = await resolveCliArtifactQuery(params, options);
      const result = await fetchResolvedGoogleMeetArtifacts(resolved);
      if (options.json) {
        await writeCliOutput(
          options,
          JSON.stringify(
            {
              ...result,
              tokenSource: resolved.token.refreshed ? "refresh-token" : "cached-access-token",
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
        resolved.token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  addGoogleMeetArtifactOptions(
    root.command("attendance").description("List Meet participants and participant sessions"),
  )
    .option("--no-merge-duplicates", "Keep duplicate participant resources as separate rows")
    .option("--late-after-minutes <n>", "Mark participants late after this many minutes", "5")
    .option("--early-before-minutes <n>", "Mark early leavers before this many minutes", "5")
    .option("--format <format>", "Output format: summary, markdown, or csv", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = await resolveCliArtifactQuery(params, options);
      const result = await fetchResolvedGoogleMeetAttendance(resolved);
      if (options.json) {
        await writeCliOutput(
          options,
          JSON.stringify(
            {
              ...result,
              tokenSource: resolved.token.refreshed ? "refresh-token" : "cached-access-token",
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
        resolved.token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  addGoogleMeetArtifactOptions(
    root
      .command("export")
      .description("Write Meet artifacts, attendance, transcript, and raw JSON into a folder"),
  )
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
      const resolved = await resolveCliArtifactQuery(params, options);
      const artifacts = await fetchResolvedGoogleMeetArtifacts(resolved);
      const attendance = await fetchResolvedGoogleMeetAttendance(resolved);
      const request: GoogleMeetExportRequest = {
        ...(resolved.meeting ? { meeting: resolved.meeting } : {}),
        ...(resolved.conferenceRecord ? { conferenceRecord: resolved.conferenceRecord } : {}),
        ...(resolved.calendarEvent?.event.id
          ? { calendarEventId: resolved.calendarEvent.event.id }
          : {}),
        ...(resolved.calendarEvent?.event.summary
          ? { calendarEventSummary: resolved.calendarEvent.event.summary }
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
            tokenSource: resolved.token.refreshed ? "refresh-token" : "cached-access-token",
            ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
          }),
          ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
          tokenSource: resolved.token.refreshed ? "refresh-token" : "cached-access-token",
        });
        return;
      }
      const bundle = await writeMeetExportBundle({
        outputDir: options.output,
        artifacts,
        attendance,
        zip: Boolean(options.zip),
        request,
        tokenSource: resolved.token.refreshed ? "refresh-token" : "cached-access-token",
        ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
      });
      const payload = {
        ...bundle,
        ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
        tokenSource: resolved.token.refreshed ? "refresh-token" : "cached-access-token",
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
