import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  captureStdout,
  expectFields,
  firstRecord,
  jsonResponse,
  parseStdoutJson,
  requestUrl,
  setupCli,
  stubMeetArtifactsApi,
} from "./test-support/cli-harness.js";

describe("google-meet CLI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  it("prints artifacts and attendance output", async () => {
    stubMeetArtifactsApi();

    const artifactsStdout = captureStdout();
    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "artifacts",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--json",
        ],
        { from: "user" },
      );
      const payload = parseStdoutJson(artifactsStdout);
      expectFields(payload, { tokenSource: "cached-access-token" });
      expectFields(firstRecord(payload.conferenceRecords), { name: "conferenceRecords/rec-1" });
      const artifact = firstRecord(payload.artifacts);
      expectFields(firstRecord(artifact.recordings), {
        name: "conferenceRecords/rec-1/recordings/r1",
      });
      expectFields(firstRecord(artifact.transcripts), {
        name: "conferenceRecords/rec-1/transcripts/t1",
      });
      const transcriptEntries = firstRecord(artifact.transcriptEntries);
      expectFields(transcriptEntries, { transcript: "conferenceRecords/rec-1/transcripts/t1" });
      expectFields(firstRecord(transcriptEntries.entries), { text: "Hello from the transcript." });
      expectFields(firstRecord(artifact.smartNotes), {
        name: "conferenceRecords/rec-1/smartNotes/sn1",
      });
    } finally {
      artifactsStdout.restore();
    }

    const attendanceStdout = captureStdout();
    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "attendance",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
        ],
        { from: "user" },
      );
      expect(attendanceStdout.output()).toContain("attendance rows: 1");
      expect(attendanceStdout.output()).toContain("participant: Alice");
      expect(attendanceStdout.output()).toContain(
        "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
      );
    } finally {
      attendanceStdout.restore();
    }
  });

  it("ends an active conference for a Meet space", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/v2/spaces/abc-defg-hij") {
        return jsonResponse({
          name: "spaces/space-resource-123",
          meetingCode: "abc-defg-hij",
          meetingUri: "https://meet.google.com/abc-defg-hij",
        });
      }
      if (url.pathname === "/v2/spaces/space-resource-123:endActiveConference") {
        return jsonResponse({});
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stdout = captureStdout();
    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "end-active-conference",
          "https://meet.google.com/abc-defg-hij",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--json",
        ],
        { from: "user" },
      );
      expectFields(parseStdoutJson(stdout), {
        space: "spaces/space-resource-123",
        ended: true,
        tokenSource: "cached-access-token",
      });
      const endCall = fetchMock.mock.calls.find(
        ([input]) =>
          input === "https://meet.googleapis.com/v2/spaces/space-resource-123:endActiveConference",
      );
      expect(endCall?.[1]).toEqual({
        method: "POST",
        body: "{}",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        },
      });
    } finally {
      stdout.restore();
    }
  });

  it("rejects access policy flags when create would use browser fallback", async () => {
    await expect(
      setupCli({
        runtime: {
          createViaBrowser: vi.fn(async () => {
            throw new Error("browser fallback should not run");
          }),
        },
      }).parseAsync(["googlemeet", "create", "--access-type", "OPEN"], { from: "user" }),
    ).rejects.toThrow("access policy options require OAuth/API room creation");
  });

  it("prints the latest conference record", async () => {
    stubMeetArtifactsApi();
    const stdout = captureStdout();

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "latest",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--meeting",
          "abc-defg-hij",
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain("space: spaces/abc-defg-hij");
      expect(stdout.output()).toContain("conference record: conferenceRecords/rec-1");
    } finally {
      stdout.restore();
    }
  });

  it("prints the latest conference record from today's calendar", async () => {
    stubMeetArtifactsApi();
    const stdout = captureStdout();

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "latest",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--today",
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain("calendar event: Project sync");
      expect(stdout.output()).toContain("conference record: conferenceRecords/rec-1");
    } finally {
      stdout.restore();
    }
  });

  it("prints calendar event previews", async () => {
    stubMeetArtifactsApi();
    const stdout = captureStdout();

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "calendar-events",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--today",
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain("meet events: 1");
      expect(stdout.output()).toContain("* Project sync");
      expect(stdout.output()).toContain("https://meet.google.com/abc-defg-hij");
    } finally {
      stdout.restore();
    }
  });

  it.each(["0", "1.5", "9007199254740993"])(
    "rejects invalid Meet API page sizes: %s",
    async (pageSize) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        setupCli({}).parseAsync(
          [
            "googlemeet",
            "artifacts",
            "--access-token",
            "token",
            "--conference-record",
            "rec-1",
            "--page-size",
            pageSize,
          ],
          { from: "user" },
        ),
      ).rejects.toThrow("page-size must be a positive integer");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("prints markdown artifact and attendance output", async () => {
    stubMeetArtifactsApi();
    const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-artifacts-"));
    const outputPath = path.join(tempDir, "artifacts.md");
    const artifactsStdout = captureStdout();

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "artifacts",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--format",
          "markdown",
          "--output",
          outputPath,
        ],
        { from: "user" },
      );
      const markdown = readFileSync(outputPath, "utf8");
      expect(artifactsStdout.output()).toContain(`wrote: ${outputPath}`);
      expect(markdown).toContain("# Google Meet Artifacts");
      expect(markdown).toContain("## conferenceRecords/rec-1");
      expect(markdown).toContain("### Transcript Entries: conferenceRecords/rec-1/transcripts/t1");
      expect(markdown).toContain("Hello from the transcript.");
    } finally {
      artifactsStdout.restore();
      rmSync(tempDir, { recursive: true, force: true });
    }

    const attendanceStdout = captureStdout();
    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "attendance",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--format",
          "markdown",
        ],
        { from: "user" },
      );
      expect(attendanceStdout.output()).toContain("# Google Meet Attendance");
      expect(attendanceStdout.output()).toContain("## Alice");
      expect(attendanceStdout.output()).toContain(
        "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
      );
    } finally {
      attendanceStdout.restore();
    }
  });

  it("prints CSV attendance output", async () => {
    stubMeetArtifactsApi();
    const stdout = captureStdout();

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "attendance",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--format",
          "csv",
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain("conferenceRecord,displayName,user");
      expect(stdout.output()).toContain("conferenceRecords/rec-1,Alice,users/alice");
    } finally {
      stdout.restore();
    }
  });

  it("neutralizes spreadsheet formulas in CSV attendance output", async () => {
    stubMeetArtifactsApi({ participantDisplayName: " \t=1+1" });
    const stdout = captureStdout();

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "attendance",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--format",
          "csv",
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain("conferenceRecords/rec-1,' \t=1+1,users/alice");
    } finally {
      stdout.restore();
    }
  });

  it("quotes carriage returns in formula-neutralized CSV cells", async () => {
    stubMeetArtifactsApi({ participantDisplayName: "\r=1+1" });
    const stdout = captureStdout();

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "attendance",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--format",
          "csv",
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain('conferenceRecords/rec-1,"\'\r=1+1",users/alice');
    } finally {
      stdout.restore();
    }
  });

  it("writes an export bundle", async () => {
    stubMeetArtifactsApi();
    const stdout = captureStdout();
    const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-export-"));

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "export",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--include-doc-bodies",
          "--zip",
          "--output",
          tempDir,
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain(`export: ${tempDir}`);
      expect(readFileSync(path.join(tempDir, "summary.md"), "utf8")).toContain(
        "# Google Meet Artifacts",
      );
      expect(readFileSync(path.join(tempDir, "attendance.csv"), "utf8")).toContain(
        "conferenceRecords/rec-1,Alice,users/alice",
      );
      expect(readFileSync(path.join(tempDir, "transcript.md"), "utf8")).toContain(
        "Hello from the transcript.",
      );
      expect(readFileSync(path.join(tempDir, "transcript.md"), "utf8")).toContain(
        "Transcript document body.",
      );
      const manifest = JSON.parse(readFileSync(path.join(tempDir, "manifest.json"), "utf8"));
      expectFields(manifest.request, {
        conferenceRecord: "rec-1",
        includeDocumentBodies: true,
      });
      expectFields(manifest, {
        tokenSource: "cached-access-token",
      });
      expectFields(manifest.counts, { attendanceRows: 1, warnings: 0 });
      expect(manifest.files).toEqual([
        "summary.md",
        "attendance.csv",
        "transcript.md",
        "artifacts.json",
        "attendance.json",
        "manifest.json",
      ]);
      const artifacts = JSON.parse(readFileSync(path.join(tempDir, "artifacts.json"), "utf8"));
      expectFields(firstRecord(artifacts.conferenceRecords), { name: "conferenceRecords/rec-1" });
      expectFields(firstRecord(firstRecord(artifacts.artifacts).transcripts), {
        documentText: "Transcript document body.",
      });
      const zip = await JSZip.loadAsync(readFileSync(`${tempDir}.zip`));
      expect(await zip.file("summary.md")?.async("string")).toContain("# Google Meet Artifacts");
    } finally {
      stdout.restore();
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(`${tempDir}.zip`, { force: true });
    }
  });

  it("neutralizes spreadsheet formulas in exported attendance CSV files", async () => {
    stubMeetArtifactsApi({ participantDisplayName: "\uFF1D1+1" });
    const stdout = captureStdout();
    const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-export-csv-"));

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "export",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--output",
          tempDir,
        ],
        { from: "user" },
      );
      expect(readFileSync(path.join(tempDir, "attendance.csv"), "utf8")).toContain(
        "conferenceRecords/rec-1,'\uFF1D1+1,users/alice",
      );
    } finally {
      stdout.restore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("includes artifact warnings in export summaries and manifests", async () => {
    stubMeetArtifactsApi({ failSmartNoteDocumentBody: true });
    const stdout = captureStdout();
    const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-export-warning-"));

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "export",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--include-doc-bodies",
          "--output",
          tempDir,
          "--json",
        ],
        { from: "user" },
      );
      const summary = readFileSync(path.join(tempDir, "summary.md"), "utf8");
      expect(summary).toContain("### Warnings");
      expect(summary).toContain("Document body warning");
      const manifest = JSON.parse(readFileSync(path.join(tempDir, "manifest.json"), "utf8"));
      expectFields(manifest.counts, { warnings: 1 });
      expectFields(firstRecord(manifest.warnings), {
        type: "smart_note_document_body",
        conferenceRecord: "conferenceRecords/rec-1",
        resource: "conferenceRecords/rec-1/smartNotes/sn1",
      });
    } finally {
      stdout.restore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prints a dry-run export manifest without writing files", async () => {
    stubMeetArtifactsApi();
    const stdout = captureStdout();
    const parentDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-export-dry-run-"));
    const outputDir = path.join(parentDir, "bundle");

    try {
      await setupCli({}).parseAsync(
        [
          "googlemeet",
          "export",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--include-doc-bodies",
          "--output",
          outputDir,
          "--dry-run",
        ],
        { from: "user" },
      );
      const payload = JSON.parse(stdout.output());
      expectFields(payload, {
        dryRun: true,
        tokenSource: "cached-access-token",
      });
      expectFields(payload.manifest.request, {
        conferenceRecord: "rec-1",
        includeDocumentBodies: true,
      });
      expectFields(payload.manifest.counts, {
        attendanceRows: 1,
        transcriptEntries: 1,
        warnings: 0,
      });
      expect(payload.manifest.files).toEqual([
        "summary.md",
        "attendance.csv",
        "transcript.md",
        "artifacts.json",
        "attendance.json",
        "manifest.json",
      ]);
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      stdout.restore();
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
