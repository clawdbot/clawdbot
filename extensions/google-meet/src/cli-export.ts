import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { listGoogleMeetCalendarEvents, type GoogleMeetCalendarLookupResult } from "./calendar.js";
import {
  formatDuration,
  formatOptional,
  type GoogleMeetExportManifest,
  type GoogleMeetExportRequest,
  type GoogleMeetExportWarning,
  writeStdoutLine,
} from "./cli-shared.js";
import type {
  GoogleMeetArtifactsResult,
  GoogleMeetAttendanceResult,
  GoogleMeetLatestConferenceRecordResult,
} from "./meet.js";

export function writeArtifactsSummary(result: GoogleMeetArtifactsResult): void {
  if (result.input) {
    writeStdoutLine("input: %s", result.input);
  }
  if (result.space) {
    writeStdoutLine("space: %s", result.space.name);
  }
  writeStdoutLine("conference records: %d", result.conferenceRecords.length);
  for (const entry of result.artifacts) {
    writeStdoutLine("");
    writeStdoutLine("record: %s", entry.conferenceRecord.name);
    writeStdoutLine("started: %s", formatOptional(entry.conferenceRecord.startTime));
    writeStdoutLine("ended: %s", formatOptional(entry.conferenceRecord.endTime));
    writeStdoutLine("participants: %d", entry.participants.length);
    writeStdoutLine("recordings: %d", entry.recordings.length);
    writeStdoutLine("transcripts: %d", entry.transcripts.length);
    writeStdoutLine(
      "transcript entries: %d",
      entry.transcriptEntries.reduce((count, transcript) => count + transcript.entries.length, 0),
    );
    writeStdoutLine("smart notes: %d", entry.smartNotes.length);
    if (entry.smartNotesError) {
      writeStdoutLine("smart notes warning: %s", entry.smartNotesError);
    }
    for (const recording of entry.recordings) {
      writeStdoutLine("- recording: %s", recording.name);
    }
    for (const transcript of entry.transcripts) {
      writeStdoutLine("- transcript: %s", transcript.name);
      if (transcript.documentTextError) {
        writeStdoutLine("- transcript document body warning: %s", transcript.documentTextError);
      }
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      if (transcriptEntries.entriesError) {
        writeStdoutLine(
          "- transcript entries warning: %s: %s",
          transcriptEntries.transcript,
          transcriptEntries.entriesError,
        );
      }
    }
    for (const smartNote of entry.smartNotes) {
      writeStdoutLine("- smart note: %s", smartNote.name);
      if (smartNote.documentTextError) {
        writeStdoutLine("- smart note document body warning: %s", smartNote.documentTextError);
      }
    }
  }
}

export function writeAttendanceSummary(result: GoogleMeetAttendanceResult): void {
  if (result.input) {
    writeStdoutLine("input: %s", result.input);
  }
  if (result.space) {
    writeStdoutLine("space: %s", result.space.name);
  }
  writeStdoutLine("conference records: %d", result.conferenceRecords.length);
  writeStdoutLine("attendance rows: %d", result.attendance.length);
  for (const row of result.attendance) {
    const identity = row.displayName || row.user || row.participant;
    writeStdoutLine("");
    writeStdoutLine("participant: %s", identity);
    writeStdoutLine("record: %s", row.conferenceRecord);
    writeStdoutLine("resource: %s", row.participant);
    writeStdoutLine("participants merged: %d", row.participants?.length ?? 1);
    writeStdoutLine("first joined: %s", formatOptional(row.firstJoinTime ?? row.earliestStartTime));
    writeStdoutLine("last left: %s", formatOptional(row.lastLeaveTime ?? row.latestEndTime));
    writeStdoutLine("duration: %s", formatDuration(row.durationMs));
    writeStdoutLine("late: %s", row.late ? formatDuration(row.lateByMs) : "no");
    writeStdoutLine("early leave: %s", row.earlyLeave ? formatDuration(row.earlyLeaveByMs) : "no");
    writeStdoutLine("sessions: %d", row.sessions.length);
    for (const session of row.sessions) {
      writeStdoutLine(
        "- %s: %s -> %s",
        session.name,
        formatOptional(session.startTime),
        formatOptional(session.endTime),
      );
    }
  }
}

export function writeLatestConferenceRecordSummary(
  result: GoogleMeetLatestConferenceRecordResult,
): void {
  writeStdoutLine("input: %s", result.input);
  writeStdoutLine("space: %s", result.space.name);
  if (!result.conferenceRecord) {
    writeStdoutLine("conference record: none");
    return;
  }
  writeStdoutLine("conference record: %s", result.conferenceRecord.name);
  writeStdoutLine("started: %s", formatOptional(result.conferenceRecord.startTime));
  writeStdoutLine("ended: %s", formatOptional(result.conferenceRecord.endTime));
}

export function writeCalendarEventsSummary(
  result: Awaited<ReturnType<typeof listGoogleMeetCalendarEvents>>,
): void {
  writeStdoutLine("calendar: %s", result.calendarId);
  writeStdoutLine("meet events: %d", result.events.length);
  for (const entry of result.events) {
    writeStdoutLine("");
    writeStdoutLine("%s%s", entry.selected ? "* " : "- ", entry.event.summary ?? "untitled");
    writeStdoutLine("meeting uri: %s", entry.meetingUri);
    writeStdoutLine(
      "starts: %s",
      formatOptional(entry.event.start?.dateTime ?? entry.event.start?.date),
    );
    writeStdoutLine("ends: %s", formatOptional(entry.event.end?.dateTime ?? entry.event.end?.date));
  }
}

function pushMarkdownLine(lines: string[], text = ""): void {
  lines.push(text);
}

function formatMarkdownOptional(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "n/a";
}

function formatMarkdownIdentity(row: GoogleMeetAttendanceResult["attendance"][number]): string {
  return row.displayName || row.user || row.participant;
}

function participantDisplayName(
  entry: GoogleMeetArtifactsResult["artifacts"][number],
  name: string,
): string {
  const participant = entry.participants.find((candidate) => candidate.name === name);
  if (!participant) {
    return name;
  }
  return (
    participant.signedinUser?.displayName ??
    participant.anonymousUser?.displayName ??
    participant.phoneUser?.displayName ??
    participant.signedinUser?.user ??
    name
  );
}

export function renderArtifactsMarkdown(result: GoogleMeetArtifactsResult): string {
  const lines: string[] = ["# Google Meet Artifacts"];
  if (result.input) {
    pushMarkdownLine(lines, `Input: ${result.input}`);
  }
  if (result.space) {
    pushMarkdownLine(lines, `Space: ${result.space.name}`);
  }
  pushMarkdownLine(lines);
  pushMarkdownLine(lines, `Conference records: ${result.conferenceRecords.length}`);
  for (const entry of result.artifacts) {
    pushMarkdownLine(lines);
    pushMarkdownLine(lines, `## ${entry.conferenceRecord.name}`);
    pushMarkdownLine(lines, `Started: ${formatMarkdownOptional(entry.conferenceRecord.startTime)}`);
    pushMarkdownLine(lines, `Ended: ${formatMarkdownOptional(entry.conferenceRecord.endTime)}`);
    pushMarkdownLine(lines);
    pushMarkdownLine(lines, `Participants: ${entry.participants.length}`);
    pushMarkdownLine(lines, `Recordings: ${entry.recordings.length}`);
    pushMarkdownLine(lines, `Transcripts: ${entry.transcripts.length}`);
    pushMarkdownLine(
      lines,
      `Transcript entries: ${entry.transcriptEntries.reduce(
        (count, transcript) => count + transcript.entries.length,
        0,
      )}`,
    );
    pushMarkdownLine(lines, `Smart notes: ${entry.smartNotes.length}`);
    const warnings = collectGoogleMeetArtifactWarnings({
      conferenceRecords: [entry.conferenceRecord],
      artifacts: [entry],
    });
    if (warnings.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Warnings");
      for (const warning of warnings) {
        const resource = warning.resource ? `${warning.resource}: ` : "";
        pushMarkdownLine(lines, `- ${resource}${warning.message}`);
      }
    }
    if (entry.recordings.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Recordings");
      for (const recording of entry.recordings) {
        pushMarkdownLine(lines, `- ${recording.name}`);
      }
    }
    if (entry.transcripts.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Transcripts");
      for (const transcript of entry.transcripts) {
        pushMarkdownLine(lines, `- ${transcript.name}`);
        if (transcript.documentTextError) {
          pushMarkdownLine(lines, `  - Document body warning: ${transcript.documentTextError}`);
        } else if (transcript.documentText) {
          pushMarkdownLine(lines, `  - Document body: ${transcript.documentText.length} chars`);
        }
      }
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, `### Transcript Entries: ${transcriptEntries.transcript}`);
      if (transcriptEntries.entriesError) {
        pushMarkdownLine(lines, `Warning: ${transcriptEntries.entriesError}`);
        continue;
      }
      if (transcriptEntries.entries.length === 0) {
        pushMarkdownLine(lines, "_No transcript entries._");
        continue;
      }
      for (const transcriptEntry of transcriptEntries.entries) {
        const times =
          transcriptEntry.startTime || transcriptEntry.endTime
            ? ` (${formatMarkdownOptional(transcriptEntry.startTime)} -> ${formatMarkdownOptional(
                transcriptEntry.endTime,
              )})`
            : "";
        const speaker = transcriptEntry.participant
          ? `${participantDisplayName(entry, transcriptEntry.participant)}: `
          : "";
        pushMarkdownLine(lines, `- ${speaker}${transcriptEntry.text ?? ""}${times}`);
      }
    }
    if (entry.smartNotes.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Smart Notes");
      for (const smartNote of entry.smartNotes) {
        pushMarkdownLine(lines, `- ${smartNote.name}`);
        if (smartNote.documentTextError) {
          pushMarkdownLine(lines, `  - Document body warning: ${smartNote.documentTextError}`);
        } else if (smartNote.documentText) {
          pushMarkdownLine(lines, `  - Document body: ${smartNote.documentText.length} chars`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderAttendanceMarkdown(result: GoogleMeetAttendanceResult): string {
  const lines: string[] = ["# Google Meet Attendance"];
  if (result.input) {
    pushMarkdownLine(lines, `Input: ${result.input}`);
  }
  if (result.space) {
    pushMarkdownLine(lines, `Space: ${result.space.name}`);
  }
  pushMarkdownLine(lines);
  pushMarkdownLine(lines, `Conference records: ${result.conferenceRecords.length}`);
  pushMarkdownLine(lines, `Attendance rows: ${result.attendance.length}`);
  for (const row of result.attendance) {
    pushMarkdownLine(lines);
    pushMarkdownLine(lines, `## ${formatMarkdownIdentity(row)}`);
    pushMarkdownLine(lines, `Record: ${row.conferenceRecord}`);
    pushMarkdownLine(lines, `Resource: ${row.participant}`);
    pushMarkdownLine(lines, `Participants merged: ${row.participants?.length ?? 1}`);
    pushMarkdownLine(
      lines,
      `First joined: ${formatMarkdownOptional(row.firstJoinTime ?? row.earliestStartTime)}`,
    );
    pushMarkdownLine(
      lines,
      `Last left: ${formatMarkdownOptional(row.lastLeaveTime ?? row.latestEndTime)}`,
    );
    pushMarkdownLine(lines, `Duration: ${formatDuration(row.durationMs)}`);
    pushMarkdownLine(lines, `Late: ${row.late ? formatDuration(row.lateByMs) : "no"}`);
    pushMarkdownLine(
      lines,
      `Early leave: ${row.earlyLeave ? formatDuration(row.earlyLeaveByMs) : "no"}`,
    );
    pushMarkdownLine(lines, `Sessions: ${row.sessions.length}`);
    for (const session of row.sessions) {
      pushMarkdownLine(
        lines,
        `- ${session.name}: ${formatMarkdownOptional(session.startTime)} -> ${formatMarkdownOptional(
          session.endTime,
        )}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function neutralizeSpreadsheetFormulaCell(text: string): string {
  return /^[ \t\r\n]*[=+\-@\uFF0B\uFF0D\uFF1D\uFF20]/u.test(text) || /^[\t\r\n]/.test(text)
    ? `'${text}`
    : text;
}

function csvCell(value: unknown): string {
  const text =
    value === undefined || value === null
      ? ""
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  const safeText = neutralizeSpreadsheetFormulaCell(text);
  return /[",\r\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

export function renderAttendanceCsv(result: GoogleMeetAttendanceResult): string {
  const rows: unknown[][] = [
    [
      "conferenceRecord",
      "displayName",
      "user",
      "participants",
      "firstJoined",
      "lastLeft",
      "durationMs",
      "sessions",
      "late",
      "lateByMs",
      "earlyLeave",
      "earlyLeaveByMs",
    ],
  ];
  for (const row of result.attendance) {
    rows.push([
      row.conferenceRecord,
      row.displayName ?? "",
      row.user ?? "",
      (row.participants ?? [row.participant]).join(";"),
      row.firstJoinTime ?? row.earliestStartTime ?? "",
      row.lastLeaveTime ?? row.latestEndTime ?? "",
      row.durationMs ?? "",
      row.sessions.length,
      row.late ?? "",
      row.lateByMs ?? "",
      row.earlyLeave ?? "",
      row.earlyLeaveByMs ?? "",
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderTranscriptMarkdown(result: GoogleMeetArtifactsResult): string {
  const lines: string[] = ["# Google Meet Transcript"];
  if (result.input) {
    pushMarkdownLine(lines, `Input: ${result.input}`);
  }
  for (const entry of result.artifacts) {
    pushMarkdownLine(lines);
    pushMarkdownLine(lines, `## ${entry.conferenceRecord.name}`);
    if (entry.transcriptEntries.length === 0) {
      pushMarkdownLine(lines, "_No transcript entries._");
      continue;
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, `### ${transcriptEntries.transcript}`);
      if (transcriptEntries.entriesError) {
        pushMarkdownLine(lines, `Warning: ${transcriptEntries.entriesError}`);
        continue;
      }
      for (const transcriptEntry of transcriptEntries.entries) {
        const speaker = transcriptEntry.participant
          ? participantDisplayName(entry, transcriptEntry.participant)
          : "unknown";
        const time = transcriptEntry.startTime ? ` [${transcriptEntry.startTime}]` : "";
        pushMarkdownLine(lines, `- ${speaker}${time}: ${transcriptEntry.text ?? ""}`);
      }
    }
    const docsTranscripts = entry.transcripts.filter((transcript) => transcript.documentText);
    if (docsTranscripts.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Transcript Document Bodies");
      for (const transcript of docsTranscripts) {
        pushMarkdownLine(lines);
        pushMarkdownLine(lines, `#### ${transcript.name}`);
        pushMarkdownLine(lines, transcript.documentText?.trim() || "_Empty document body._");
      }
    }
    const smartNotes = entry.smartNotes.filter((smartNote) => smartNote.documentText);
    if (smartNotes.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Smart Note Document Bodies");
      for (const smartNote of smartNotes) {
        pushMarkdownLine(lines);
        pushMarkdownLine(lines, `#### ${smartNote.name}`);
        pushMarkdownLine(lines, smartNote.documentText?.trim() || "_Empty document body._");
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function collectGoogleMeetArtifactWarnings(
  result: GoogleMeetArtifactsResult,
): GoogleMeetExportWarning[] {
  const warnings: GoogleMeetExportWarning[] = [];
  for (const entry of result.artifacts) {
    const conferenceRecord = entry.conferenceRecord.name;
    if (entry.smartNotesError) {
      warnings.push({
        type: "smart_notes",
        conferenceRecord,
        message: entry.smartNotesError,
      });
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      if (transcriptEntries.entriesError) {
        warnings.push({
          type: "transcript_entries",
          conferenceRecord,
          resource: transcriptEntries.transcript,
          message: transcriptEntries.entriesError,
        });
      }
    }
    for (const transcript of entry.transcripts) {
      if (transcript.documentTextError) {
        warnings.push({
          type: "transcript_document_body",
          conferenceRecord,
          resource: transcript.name,
          message: transcript.documentTextError,
        });
      }
    }
    for (const smartNote of entry.smartNotes) {
      if (smartNote.documentTextError) {
        warnings.push({
          type: "smart_note_document_body",
          conferenceRecord,
          resource: smartNote.name,
          message: smartNote.documentTextError,
        });
      }
    }
  }
  return warnings;
}

export function buildGoogleMeetExportManifest(params: {
  artifacts: GoogleMeetArtifactsResult;
  attendance: GoogleMeetAttendanceResult;
  files: string[];
  request?: GoogleMeetExportRequest;
  tokenSource?: "cached-access-token" | "refresh-token";
  calendarEvent?: GoogleMeetCalendarLookupResult;
  zipFile?: string;
}): GoogleMeetExportManifest {
  const transcriptEntryCount = params.artifacts.artifacts.reduce(
    (count, entry) =>
      count +
      entry.transcriptEntries.reduce(
        (entryCount, transcript) => entryCount + transcript.entries.length,
        0,
      ),
    0,
  );
  const warnings = collectGoogleMeetArtifactWarnings(params.artifacts);
  return {
    generatedAt: new Date().toISOString(),
    ...(params.request ? { request: params.request } : {}),
    ...(params.tokenSource ? { tokenSource: params.tokenSource } : {}),
    ...(params.calendarEvent ? { calendarEvent: params.calendarEvent } : {}),
    inputs: {
      ...(params.artifacts.input ? { artifacts: params.artifacts.input } : {}),
      ...(params.attendance.input ? { attendance: params.attendance.input } : {}),
    },
    counts: {
      conferenceRecords: params.artifacts.conferenceRecords.length,
      artifacts: params.artifacts.artifacts.length,
      attendanceRows: params.attendance.attendance.length,
      recordings: params.artifacts.artifacts.reduce(
        (count, entry) => count + entry.recordings.length,
        0,
      ),
      transcripts: params.artifacts.artifacts.reduce(
        (count, entry) => count + entry.transcripts.length,
        0,
      ),
      transcriptEntries: transcriptEntryCount,
      smartNotes: params.artifacts.artifacts.reduce(
        (count, entry) => count + entry.smartNotes.length,
        0,
      ),
      warnings: warnings.length,
    },
    conferenceRecords: params.artifacts.conferenceRecords.map((record) => record.name),
    files: params.files,
    ...(params.zipFile ? { zipFile: params.zipFile } : {}),
    warnings,
  };
}

export function googleMeetExportFileNames(): string[] {
  return [
    "summary.md",
    "attendance.csv",
    "transcript.md",
    "artifacts.json",
    "attendance.json",
    "manifest.json",
  ];
}

function defaultExportDirectory(): string {
  return `google-meet-export-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export async function writeMeetExportBundle(params: {
  outputDir?: string;
  artifacts: GoogleMeetArtifactsResult;
  attendance: GoogleMeetAttendanceResult;
  zip?: boolean;
  request?: GoogleMeetExportRequest;
  tokenSource?: "cached-access-token" | "refresh-token";
  calendarEvent?: GoogleMeetCalendarLookupResult;
}): Promise<{ outputDir: string; files: string[]; zipFile?: string }> {
  const outputDir = params.outputDir?.trim() || defaultExportDirectory();
  await mkdir(outputDir, { recursive: true });
  const zipFile = params.zip ? `${outputDir.replace(/\/$/, "")}.zip` : undefined;
  const fileNames = googleMeetExportFileNames();
  const files = [
    {
      name: "summary.md",
      content: `${renderArtifactsMarkdown(params.artifacts)}\n${renderAttendanceMarkdown(params.attendance)}`,
    },
    { name: "attendance.csv", content: renderAttendanceCsv(params.attendance) },
    { name: "transcript.md", content: renderTranscriptMarkdown(params.artifacts) },
    { name: "artifacts.json", content: `${JSON.stringify(params.artifacts, null, 2)}\n` },
    { name: "attendance.json", content: `${JSON.stringify(params.attendance, null, 2)}\n` },
    {
      name: "manifest.json",
      content: `${JSON.stringify(
        buildGoogleMeetExportManifest({
          artifacts: params.artifacts,
          attendance: params.attendance,
          files: fileNames,
          ...(params.request ? { request: params.request } : {}),
          ...(params.tokenSource ? { tokenSource: params.tokenSource } : {}),
          ...(params.calendarEvent ? { calendarEvent: params.calendarEvent } : {}),
          ...(zipFile ? { zipFile } : {}),
        }),
        null,
        2,
      )}\n`,
    },
  ];
  for (const file of files) {
    await writeFile(path.join(outputDir, file.name), file.content, "utf8");
  }
  const result: { outputDir: string; files: string[]; zipFile?: string } = {
    outputDir,
    files: files.map((file) => path.join(outputDir, file.name)),
  };
  if (zipFile) {
    const zip = new JSZip();
    for (const file of files) {
      zip.file(file.name, file.content);
    }
    await writeFile(zipFile, await zip.generateAsync({ type: "nodebuffer" }));
    result.zipFile = zipFile;
  }
  return result;
}
