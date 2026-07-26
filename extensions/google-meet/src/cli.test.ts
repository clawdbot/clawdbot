import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleMeetRuntime } from "./runtime.js";
import {
  captureStdout,
  expectFields,
  jsonResponse,
  parseStdoutJson,
  requestUrl,
  setupCli,
} from "./test-support/cli-harness.js";

describe("google-meet CLI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
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
              agentId: "main",
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
              agentId: "main",
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
      const payload = JSON.parse(output) as Record<string, unknown>;
      expectFields(payload, {
        ok: true,
        configured: true,
        tokenSource: "refresh-token",
      });
      const checks = payload.checks as unknown[];
      expectFields(checks[0], { id: "oauth-config", ok: true });
      expectFields(checks[1], { id: "oauth-token", ok: true });
      expect(ensureRuntime).not.toHaveBeenCalled();
      const body = fetchMock.mock.calls.at(0)?.[1]?.body as URLSearchParams;
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
      const payload = parseStdoutJson(stdout);
      expectFields(payload, {
        ok: true,
        tokenSource: "refresh-token",
        createdSpace: "spaces/new-space",
        meetingUri: "https://meet.google.com/new-abcd-xyz",
      });
      const checks = payload.checks as unknown[];
      expectFields(checks[0], { id: "oauth-config", ok: true });
      expectFields(checks[1], { id: "oauth-token", ok: true });
      expectFields(checks[2], { id: "meet-spaces-create", ok: true });
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
