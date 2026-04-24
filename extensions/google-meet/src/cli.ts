import { createInterface } from "node:readline/promises";
import { format } from "node:util";
import type { Command } from "commander";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import { buildGoogleMeetPreflightReport, fetchGoogleMeetSpace } from "./meet.js";
import {
  buildGoogleMeetAuthUrl,
  createGoogleMeetOAuthState,
  createGoogleMeetPkce,
  exchangeGoogleMeetAuthCode,
  resolveGoogleMeetAccessToken,
  waitForGoogleMeetAuthCode,
} from "./oauth.js";
import type { GoogleMeetRuntime } from "./runtime.js";

type JoinOptions = {
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetMode;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
};

type OAuthLoginOptions = {
  clientId?: string;
  clientSecret?: string;
  manual?: boolean;
  json?: boolean;
  timeoutSec?: string;
};

type ResolveSpaceOptions = {
  meeting?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
  json?: boolean;
};

function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStdoutLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

async function promptInput(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric value, received ${value}`);
  }
  return parsed;
}

function resolveMeetingInput(config: GoogleMeetConfig, value?: string): string {
  const meeting = value?.trim() || config.defaults.meeting;
  if (!meeting) {
    throw new Error(
      "Meeting input is required. Pass a URL/meeting code or configure defaults.meeting.",
    );
  }
  return meeting;
}

function resolveTokenOptions(
  config: GoogleMeetConfig,
  options: ResolveSpaceOptions,
): {
  meeting: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
} {
  return {
    meeting: resolveMeetingInput(config, options.meeting),
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
  };
}

export function registerGoogleMeetCli(params: {
  program: Command;
  config: GoogleMeetConfig;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
}) {
  const root = params.program
    .command("googlemeet")
    .description("Google Meet participant utilities")
    .addHelpText("after", () => `\nDocs: https://docs.openclaw.ai/plugins/google-meet\n`);

  const auth = root.command("auth").description("Google Meet OAuth helpers");

  auth
    .command("login")
    .description("Run a PKCE OAuth flow and print refresh-token JSON to store in plugin config")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--manual", "Use copy/paste callback flow instead of localhost callback")
    .option("--json", "Print the token payload as JSON", false)
    .option("--timeout-sec <n>", "Local callback timeout in seconds", "300")
    .action(async (options: OAuthLoginOptions) => {
      const clientId = options.clientId?.trim() || params.config.oauth.clientId;
      const clientSecret = options.clientSecret?.trim() || params.config.oauth.clientSecret;
      if (!clientId) {
        throw new Error(
          "Missing Google Meet OAuth client id. Configure oauth.clientId or pass --client-id.",
        );
      }
      const { verifier, challenge } = createGoogleMeetPkce();
      const state = createGoogleMeetOAuthState();
      const authUrl = buildGoogleMeetAuthUrl({
        clientId,
        challenge,
        state,
      });
      const code = await waitForGoogleMeetAuthCode({
        state,
        manual: Boolean(options.manual),
        timeoutMs: (parseOptionalNumber(options.timeoutSec) ?? 300) * 1000,
        authUrl,
        promptInput,
        writeLine: (message) => writeStdoutLine("%s", message),
      });
      const tokens = await exchangeGoogleMeetAuthCode({
        clientId,
        clientSecret,
        code,
        verifier,
      });
      if (!tokens.refreshToken) {
        throw new Error(
          "Google OAuth did not return a refresh token. Re-run the flow with consent and offline access.",
        );
      }
      const payload = {
        oauth: {
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
        },
        scope: tokens.scope,
        tokenType: tokens.tokenType,
      };
      if (!options.json) {
        writeStdoutLine("Paste this into plugins.entries.google-meet.config:");
      }
      writeStdoutJson(payload);
    });

  root
    .command("join")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome, chrome-node, or twilio")
    .option("--mode <mode>", "Mode: realtime or transcribe")
    .option("--dial-in-number <phone>", "Meet dial-in number for Twilio transport")
    .option("--pin <pin>", "Meet phone PIN; # is appended if omitted")
    .option("--dtmf-sequence <sequence>", "Explicit Twilio DTMF sequence")
    .action(async (url: string | undefined, options: JoinOptions) => {
      const rt = await params.ensureRuntime();
      const result = await rt.join({
        url: resolveMeetingInput(params.config, url),
        transport: options.transport,
        mode: options.mode,
        dialInNumber: options.dialInNumber,
        pin: options.pin,
        dtmfSequence: options.dtmfSequence,
      });
      writeStdoutJson(result.session);
    });

  root
    .command("resolve-space")
    .description("Resolve a Meet URL, meeting code, or spaces/{id} to its canonical space")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const resolved = resolveTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const space = await fetchGoogleMeetSpace({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
      });
      if (options.json) {
        writeStdoutJson(space);
        return;
      }
      writeStdoutLine("input: %s", resolved.meeting);
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

  root
    .command("preflight")
    .description("Validate OAuth + meeting resolution prerequisites for Meet media work")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const resolved = resolveTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const space = await fetchGoogleMeetSpace({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
      });
      const report = buildGoogleMeetPreflightReport({
        input: resolved.meeting,
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

  root
    .command("status")
    .argument("[session-id]", "Meet session ID")
    .action(async (sessionId?: string) => {
      const rt = await params.ensureRuntime();
      writeStdoutJson(rt.status(sessionId));
    });

  root
    .command("setup")
    .description("Show Google Meet transport setup status")
    .action(async () => {
      const rt = await params.ensureRuntime();
      writeStdoutJson(rt.setupStatus());
    });

  root
    .command("leave")
    .argument("<session-id>", "Meet session ID")
    .action(async (sessionId: string) => {
      const rt = await params.ensureRuntime();
      const result = await rt.leave(sessionId);
      if (!result.found) {
        throw new Error("session not found");
      }
      writeStdoutLine("left %s", sessionId);
    });

  root
    .command("speak")
    .argument("<session-id>", "Meet session ID")
    .argument("[message]", "Realtime instructions to speak now")
    .action(async (sessionId: string, message?: string) => {
      const rt = await params.ensureRuntime();
      const result = rt.speak(sessionId, message);
      if (!result.found) {
        throw new Error("session not found");
      }
      if (!result.spoken) {
        throw new Error("session has no active realtime audio bridge");
      }
      writeStdoutLine("speaking on %s", sessionId);
    });
}
