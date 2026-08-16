// Shared Google Meet CLI test harness.
import { Command } from "commander";
import { expect, vi } from "vitest";
import { registerGoogleMeetCli } from "../cli.js";
import { resolveGoogleMeetConfig } from "../config.js";
import type { GoogleMeetRuntime } from "../runtime.js";

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

export function captureStdout() {
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

export function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

export function firstRecord(value: unknown): Record<string, unknown> {
  expect(Array.isArray(value)).toBe(true);
  const [record] = value as unknown[];
  if (!record || typeof record !== "object") {
    throw new Error("expected first record");
  }
  return record as Record<string, unknown>;
}

export function parseStdoutJson(stdout: { output: () => string }): Record<string, unknown> {
  return JSON.parse(stdout.output()) as Record<string, unknown>;
}

export function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

export function stubMeetArtifactsApi(
  options: { failSmartNoteDocumentBody?: boolean; participantDisplayName?: string } = {},
) {
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
              signedinUser: {
                user: "users/alice",
                displayName: options.participantDisplayName ?? "Alice",
              },
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

export function setupCli(params: {
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
