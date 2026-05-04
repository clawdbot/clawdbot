import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGoogleMeetCli } from "./cli.js";
import { resolveGoogleMeetConfig } from "./config.js";
import type { GoogleMeetRuntime } from "./runtime.js";

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
    }): Promise<{
      response: Response;
      release: () => Promise<void>;
    }> => ({
      response: await fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
  };
});

function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function stubMeetArtifactsApi(options: { failSmartNoteDocumentBody?: boolean } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/v2/spaces/abc-defg-hij") {
        return jsonResponse({
          name: "spaces/abc-defg-hij",
          meetingCode: "abc-defg-hij",
          meetingUri: "https://meet.google.com/abc-defg-hij",
        });
      }
      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        return jsonResponse({
          items: [
            {
              id: "event-1",
              summary: "Project sync",
              hangoutLink: "https://meet.google.com/abc-defg-hij",
              start: { dateTime: "2026-04-25T10:00:00Z" },
              end: { dateTime: "2026-04-25T10:30:00Z" },
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords") {
        return jsonResponse({
          conferenceRecords: [
            {
              name: "conferenceRecords/rec-1",
              space: "spaces/abc-defg-hij",
              startTime: "2026-04-25T10:00:00Z",
              endTime: "2026-04-25T10:30:00Z",
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1") {
        return jsonResponse({
          name: "conferenceRecords/rec-1",
          space: "spaces/abc-defg-hij",
          startTime: "2026-04-25T10:00:00Z",
          endTime: "2026-04-25T10:30:00Z",
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants") {
        return jsonResponse({
          participants: [
            {
              name: "conferenceRecords/rec-1/participants/p1",
              signedinUser: { user: "users/alice", displayName: "Alice" },
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants/p1/participantSessions") {
        return jsonResponse({
          participantSessions: [
            {
              name: "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
              startTime: "2026-04-25T10:00:00Z",
              endTime: "2026-04-25T10:10:00Z",
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/recordings") {
        return jsonResponse({
          recordings: [
            {
              name: "conferenceRecords/rec-1/recordings/r1",
              state: "FILE_GENERATED",
              driveDestination: { file: "drive-file-1" },
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/transcripts") {
        return jsonResponse({
          transcripts: [
            {
              name: "conferenceRecords/rec-1/transcripts/t1",
              state: "FILE_GENERATED",
              docsDestination: { document: "doc-1" },
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/transcripts/t1/entries") {
        return jsonResponse({
          transcriptEntries: [
            {
              name: "conferenceRecords/rec-1/transcripts/t1/entries/e1",
              text: "Hello from the transcript.",
              startTime: "2026-04-25T10:01:00Z",
              participant: "conferenceRecords/rec-1/participants/p1",
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/smartNotes") {
        return jsonResponse({
          smartNotes: [
            {
              name: "conferenceRecords/rec-1/smartNotes/sn1",
              state: "FILE_GENERATED",
              docsDestination: { document: "notes-1" },
            },
          ],
        });
      }
      if (url.pathname === "/drive/v3/files/doc-1/export") {
        return new Response("Transcript document body.", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      if (url.pathname === "/drive/v3/files/notes-1/export") {
        if (options.failSmartNoteDocumentBody) {
          return new Response("insufficientPermissions", { status: 403 });
        }
        return new Response("Smart note document body.", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

function setupCli(params: {
  config?: Parameters<typeof resolveGoogleMeetConfig>[0];
  runtime?: Partial<GoogleMeetRuntime>;
  ensureRuntime?: () => Promise<GoogleMeetRuntime>;
  callGatewayFromCli?: Parameters<typeof registerGoogleMeetCli>[0]["callGatewayFromCli"];
}) {
  const program = new Command();
  registerGoogleMeetCli({
    program,
    config: resolveGoogleMeetConfig(params.config ?? {}),
    ensureRuntime:
      params.ensureRuntime ?? (async () => (params.runtime ?? {}) as unknown as GoogleMeetRuntime),
    callGatewayFromCli:
      params.callGatewayFromCli ??
      (vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
      }) as NonNullable<Parameters<typeof registerGoogleMeetCli>[0]["callGatewayFromCli"]>),
  });
  return program;
}

describe("google-meet CLI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prints setup checks as text and JSON", async () => {
    {
      const stdout = captureStdout();
      try {
        await setupCli({
          runtime: {
            setupStatus: async () => ({
              ok: true,
              checks: [
                {
                  id: "audio-bridge",
                  ok: true,
                  message: "Chrome command-pair talk-back audio bridge configured (pcm16-24khz)",
                },
              ],
            }),
          },
        }).parseAsync(["googlemeet", "setup"], { from: "user" });
        expect(stdout.output()).toContain("Google Meet setup: OK");
        expect(stdout.output()).toContain(
          "[ok] audio-bridge: Chrome command-pair talk-back audio bridge configured (pcm16-24khz)",
        );
        expect(stdout.output()).not.toContain('"checks"');
      } finally {
        stdout.restore();
      }
    }

    {
      const stdout = captureStdout();
      try {
        await setupCli({
          runtime: {
            setupStatus: async () => ({
              ok: false,
              checks: [{ id: "twilio-voice-call-plugin", ok: false, message: "missing" }],
            }),
          },
        }).parseAsync(["googlemeet", "setup", "--json"], { from: "user" });
        expect(JSON.parse(stdout.output())).toMatchObject({
          ok: false,
          checks: [{ id: "twilio-voice-call-plugin", ok: false }],
        });
      } finally {
        stdout.restore();
      }
    }
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
      expect(JSON.parse(artifactsStdout.output())).toMatchObject({
        conferenceRecords: [{ name: "conferenceRecords/rec-1" }],
        artifacts: [
          {
            recordings: [{ name: "conferenceRecords/rec-1/recordings/r1" }],
            transcripts: [{ name: "conferenceRecords/rec-1/transcripts/t1" }],
            transcriptEntries: [
              {
                transcript: "conferenceRecords/rec-1/transcripts/t1",
                entries: [{ text: "Hello from the transcript." }],
              },
            ],
            smartNotes: [{ name: "conferenceRecords/rec-1/smartNotes/sn1" }],
          },
        ],
        tokenSource: "cached-access-token",
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
      expect(JSON.parse(stdout.output())).toMatchObject({
        space: "spaces/space-resource-123",
        ended: true,
        tokenSource: "cached-access-token",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://meet.googleapis.com/v2/spaces/space-resource-123:endActiveConference",
        expect.objectContaining({ method: "POST", body: "{}" }),
      );
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
      expect(manifest).toMatchObject({
        request: {
          conferenceRecord: "rec-1",
          includeDocumentBodies: true,
        },
        tokenSource: "cached-access-token",
        counts: {
          attendanceRows: 1,
          warnings: 0,
        },
        files: expect.arrayContaining([
          "summary.md",
          "attendance.csv",
          "transcript.md",
          "artifacts.json",
          "attendance.json",
          "manifest.json",
        ]),
      });
      expect(JSON.parse(readFileSync(path.join(tempDir, "artifacts.json"), "utf8"))).toMatchObject({
        conferenceRecords: [{ name: "conferenceRecords/rec-1" }],
        artifacts: [{ transcripts: [{ documentText: "Transcript document body." }] }],
      });
      expect(readFileSync(`${tempDir}.zip`).subarray(0, 4).toString("hex")).toBe("504b0304");
    } finally {
      stdout.restore();
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(`${tempDir}.zip`, { force: true });
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
      expect(manifest).toMatchObject({
        counts: { warnings: 1 },
        warnings: [
          {
            type: "smart_note_document_body",
            conferenceRecord: "conferenceRecords/rec-1",
            resource: "conferenceRecords/rec-1/smartNotes/sn1",
          },
        ],
      });
    } finally {
      stdout.restore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts --json on session status", async () => {
    const stdout = captureStdout();
    try {
      await setupCli({
        runtime: {
          status: async () => ({
            found: true,
            sessions: [
              {
                id: "meet_1",
                url: "https://meet.google.com/abc-defg-hij",
                state: "active",
                transport: "twilio",
                mode: "agent",
                participantIdentity: "Twilio PSTN participant",
                createdAt: "2026-04-25T00:00:00.000Z",
                updatedAt: "2026-04-25T00:00:01.000Z",
                realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
                notes: [],
              },
            ],
          }),
        },
      }).parseAsync(["googlemeet", "status", "--json"], { from: "user" });
      expect(JSON.parse(stdout.output())).toMatchObject({
        found: true,
        sessions: [{ id: "meet_1", transport: "twilio" }],
      });
    } finally {
      stdout.restore();
    }
  });

  it("delegates session status to the gateway-owned runtime when available", async () => {
    const callGatewayFromCli = vi.fn(async () => ({
      found: true,
      sessions: [
        {
          id: "meet_gateway",
          url: "https://meet.google.com/abc-defg-hij",
          state: "active",
          transport: "chrome-node",
          mode: "agent",
          participantIdentity: "signed-in Google Chrome profile on a paired node",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:01.000Z",
          realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
          notes: [],
        },
      ],
    }));
    const ensureRuntime = vi.fn(async () => {
      throw new Error("local runtime should not be loaded");
    });
    const stdout = captureStdout();
    try {
      await setupCli({
        callGatewayFromCli,
        ensureRuntime: ensureRuntime as unknown as () => Promise<GoogleMeetRuntime>,
      }).parseAsync(["googlemeet", "status", "--json"], { from: "user" });
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "googlemeet.status",
        { json: true, timeout: "5000" },
        { sessionId: undefined },
        { progress: false },
      );
      expect(ensureRuntime).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.output())).toMatchObject({
        found: true,
        sessions: [{ id: "meet_gateway", transport: "chrome-node" }],
      });
    } finally {
      stdout.restore();
    }
  });

  it("delegates join to the gateway-owned runtime when available", async () => {
    const callGatewayFromCli = vi.fn(async () => ({
      session: {
        id: "meet_gateway",
        url: "https://meet.google.com/abc-defg-hij",
        state: "active",
        transport: "chrome-node",
        mode: "realtime",
        participantIdentity: "signed-in Google Chrome profile on a paired node",
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:01.000Z",
        realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
        notes: [],
      },
    }));
    const ensureRuntime = vi.fn(async () => {
      throw new Error("local runtime should not be loaded");
    });
    const stdout = captureStdout();
    try {
      await setupCli({
        callGatewayFromCli,
        ensureRuntime: ensureRuntime as unknown as () => Promise<GoogleMeetRuntime>,
      }).parseAsync(
        [
          "googlemeet",
          "join",
          "https://meet.google.com/abc-defg-hij",
          "--transport",
          "chrome-node",
          "--mode",
          "realtime",
          "--message",
          "Hello meeting",
        ],
        { from: "user" },
      );
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "googlemeet.join",
        { json: true, timeout: expect.any(String) },
        {
          url: "https://meet.google.com/abc-defg-hij",
          transport: "chrome-node",
          mode: "realtime",
          message: "Hello meeting",
          dialInNumber: undefined,
          pin: undefined,
          dtmfSequence: undefined,
        },
        { progress: false },
      );
      expect(ensureRuntime).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.output())).toMatchObject({
        id: "meet_gateway",
        transport: "chrome-node",
      });
    } finally {
      stdout.restore();
    }
  });

  it("runs a listen-first health probe", async () => {
    const testListen = vi.fn(async () => ({
      createdSession: true,
      listenVerified: true,
      listenTimedOut: false,
      transcriptLines: 1,
      session: {
        id: "meet_1",
        url: "https://meet.google.com/abc-defg-hij",
        state: "active" as const,
        transport: "chrome-node" as const,
        mode: "transcribe" as const,
        participantIdentity: "signed-in Google Chrome profile on a paired node",
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:01.000Z",
        realtime: { enabled: false, provider: "openai", toolPolicy: "safe-read-only" },
        notes: [],
      },
    }));
    const stdout = captureStdout();
    try {
      await setupCli({
        runtime: { testListen },
      }).parseAsync(
        [
          "googlemeet",
          "test-listen",
          "https://meet.google.com/abc-defg-hij",
          "--transport",
          "chrome-node",
          "--timeout-ms",
          "30000",
        ],
        { from: "user" },
      );
      expect(testListen).toHaveBeenCalledWith({
        url: "https://meet.google.com/abc-defg-hij",
        transport: "chrome-node",
        timeoutMs: 30000,
      });
      expect(JSON.parse(stdout.output())).toMatchObject({
        listenVerified: true,
        transcriptLines: 1,
      });
    } finally {
      stdout.restore();
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
      expect(payload).toMatchObject({
        dryRun: true,
        manifest: {
          request: {
            conferenceRecord: "rec-1",
            includeDocumentBodies: true,
          },
          counts: {
            attendanceRows: 1,
            transcriptEntries: 1,
            warnings: 0,
          },
          files: expect.arrayContaining(["summary.md", "manifest.json"]),
        },
        tokenSource: "cached-access-token",
      });
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      stdout.restore();
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it("prints human-readable session doctor output", async () => {
    const stdout = captureStdout();
    try {
      await setupCli({
        runtime: {
          status: async () => ({
            found: true,
            session: {
              id: "meet_1",
              url: "https://meet.google.com/abc-defg-hij",
              state: "active",
              transport: "chrome-node",
              mode: "agent",
              participantIdentity: "signed-in Google Chrome profile on a paired node",
              createdAt: "2026-04-25T00:00:00.000Z",
              updatedAt: "2026-04-25T00:00:01.000Z",
              realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
              chrome: {
                audioBackend: "blackhole-2ch",
                launched: true,
                nodeId: "node-1",
                audioBridge: { type: "node-command-pair", provider: "openai" },
                health: {
                  inCall: true,
                  captioning: true,
                  transcriptLines: 2,
                  lastCaptionAt: "2026-04-25T00:00:03.000Z",
                  lastCaptionSpeaker: "Alice",
                  lastCaptionText: "Can everyone hear OpenClaw?",
                  providerConnected: true,
                  realtimeReady: true,
                  audioInputActive: true,
                  audioOutputActive: false,
                  lastInputAt: "2026-04-25T00:00:02.000Z",
                  lastInputBytes: 160,
                  lastOutputBytes: 0,
                },
              },
              notes: [],
            },
          }),
        },
      }).parseAsync(["googlemeet", "doctor", "meet_1"], { from: "user" });
      expect(stdout.output()).toContain("session: meet_1");
      expect(stdout.output()).toContain("node: node-1");
      expect(stdout.output()).toContain("provider connected: yes");
      expect(stdout.output()).toContain("captioning: yes");
      expect(stdout.output()).toContain("transcript lines: 2");
      expect(stdout.output()).toContain("last caption text: Alice: Can everyone hear OpenClaw?");
      expect(stdout.output()).toContain("audio input active: yes");
      expect(stdout.output()).toContain("audio output active: no");
    } finally {
      stdout.restore();
    }
  });

  it("prints Twilio session doctor output", async () => {
    const stdout = captureStdout();
    try {
      await setupCli({
        runtime: {
          status: async () => ({
            found: true,
            session: {
              id: "meet_1",
              url: "https://meet.google.com/abc-defg-hij",
              state: "active",
              transport: "twilio",
              mode: "agent",
              participantIdentity: "Twilio phone participant",
              createdAt: "2026-04-25T00:00:00.000Z",
              updatedAt: "2026-04-25T00:00:01.000Z",
              realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
              twilio: {
                dialInNumber: "+15551234567",
                pinProvided: true,
                dtmfSequence: "ww123456#",
                voiceCallId: "call-1",
                dtmfSent: true,
                introSent: true,
              },
              notes: [],
            },
          }),
        },
      }).parseAsync(["googlemeet", "doctor", "meet_1"], { from: "user" });
      expect(stdout.output()).toContain("session: meet_1");
      expect(stdout.output()).toContain("transport: twilio");
      expect(stdout.output()).toContain("twilio dial-in: +15551234567");
      expect(stdout.output()).toContain("voice call id: call-1");
      expect(stdout.output()).toContain("dtmf sent: yes");
      expect(stdout.output()).toContain("intro sent: yes");
      expect(stdout.output()).not.toContain("audio input active:");
    } finally {
      stdout.restore();
    }
  });

  it("verifies OAuth refresh without printing secrets", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        access_token: "new-access-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ensureRuntime = vi.fn(async () => {
      throw new Error("runtime should not be loaded for OAuth doctor");
    });
    const stdout = captureStdout();

    try {
      await setupCli({
        config: {
          oauth: {
            clientId: "client-id",
            clientSecret: "client-secret",
            refreshToken: "rt-secret",
          },
        },
        ensureRuntime: ensureRuntime as unknown as () => Promise<GoogleMeetRuntime>,
      }).parseAsync(["googlemeet", "doctor", "--oauth", "--json"], { from: "user" });
      const output = stdout.output();
      expect(output).not.toContain("new-access-token");
      expect(output).not.toContain("rt-secret");
      expect(output).not.toContain("client-secret");
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        configured: true,
        tokenSource: "refresh-token",
        checks: [
          { id: "oauth-config", ok: true },
          { id: "oauth-token", ok: true },
        ],
      });
      expect(ensureRuntime).not.toHaveBeenCalled();
      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
    } finally {
      stdout.restore();
    }
  });

  it("can prove Google Meet API create access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input).href;
        if (url === "https://oauth2.googleapis.com/token") {
          return jsonResponse({
            access_token: "new-access-token",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        if (url === "https://meet.googleapis.com/v2/spaces") {
          return jsonResponse({
            name: "spaces/new-space",
            meetingUri: "https://meet.google.com/new-abcd-xyz",
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const stdout = captureStdout();

    try {
      await setupCli({
        config: {
          oauth: {
            clientId: "client-id",
            refreshToken: "refresh-token",
          },
        },
      }).parseAsync(["googlemeet", "doctor", "--oauth", "--create-space", "--json"], {
        from: "user",
      });
      expect(JSON.parse(stdout.output())).toMatchObject({
        ok: true,
        tokenSource: "refresh-token",
        createdSpace: "spaces/new-space",
        meetingUri: "https://meet.google.com/new-abcd-xyz",
        checks: [
          { id: "oauth-config", ok: true },
          { id: "oauth-token", ok: true },
          { id: "meet-spaces-create", ok: true },
        ],
      });
    } finally {
      stdout.restore();
    }
  });

  it("recovers and summarizes an existing Meet tab", async () => {
    const stdout = captureStdout();
    try {
      await setupCli({
        config: { defaultTransport: "chrome-node" },
        runtime: {
          recoverCurrentTab: async () => ({
            transport: "chrome-node",
            nodeId: "node-1",
            found: true,
            targetId: "tab-1",
            tab: { targetId: "tab-1", url: "https://meet.google.com/abc-defg-hij" },
            browser: {
              inCall: false,
              manualActionRequired: true,
              manualActionReason: "meet-admission-required",
              manualActionMessage: "Admit the OpenClaw browser participant in Google Meet.",
              browserUrl: "https://meet.google.com/abc-defg-hij",
            },
            message: "Admit the OpenClaw browser participant in Google Meet.",
          }),
        },
      }).parseAsync(["googlemeet", "recover-tab"], { from: "user" });
      expect(stdout.output()).toContain("Google Meet current tab: found");
      expect(stdout.output()).toContain("target: tab-1");
      expect(stdout.output()).toContain("manual reason: meet-admission-required");
    } finally {
      stdout.restore();
    }
  });
});
