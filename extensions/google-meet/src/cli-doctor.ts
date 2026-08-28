import type { GoogleMeetCliCommandContext } from "./cli-command-context.js";
import {
  callGoogleMeetGateway,
  parseOptionalNumber,
  type DoctorOptions,
  writeDoctorStatus,
  writeStdoutJson,
  writeStdoutLine,
} from "./cli-shared.js";
import type { GoogleMeetConfig } from "./config.js";
import { createGoogleMeetSpace, fetchGoogleMeetSpace } from "./meet.js";
import { resolveGoogleMeetAccessToken } from "./oauth.js";
import type { GoogleMeetRuntime } from "./runtime.js";

type OAuthDoctorCheck = {
  id: string;
  ok: boolean;
  message: string;
};

type OAuthDoctorReport = {
  ok: boolean;
  configured: boolean;
  tokenSource?: "cached-access-token" | "refresh-token";
  expiresAt?: number;
  scope?: string;
  meetingUri?: string;
  createdSpace?: string;
  checks: OAuthDoctorCheck[];
};

function sanitizeOAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(access_token["'=:\s]+)[^"',\s&]+/gi, "$1[redacted]")
    .replace(/(refresh_token["'=:\s]+)[^"',\s&]+/gi, "$1[redacted]")
    .replace(/(client_secret["'=:\s]+)[^"',\s&]+/gi, "$1[redacted]");
}

async function buildOAuthDoctorReport(
  config: GoogleMeetConfig,
  options: DoctorOptions,
): Promise<OAuthDoctorReport> {
  const clientId = options.clientId?.trim() || config.oauth.clientId;
  const clientSecret = options.clientSecret?.trim() || config.oauth.clientSecret;
  const refreshToken = options.refreshToken?.trim() || config.oauth.refreshToken;
  const accessToken = options.accessToken?.trim() || config.oauth.accessToken;
  const expiresAt = parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt;
  const checks: OAuthDoctorCheck[] = [];

  const hasRefreshConfig = Boolean(clientId && refreshToken);
  const hasAccessConfig = Boolean(accessToken);
  if (!hasRefreshConfig && !hasAccessConfig) {
    checks.push({
      id: "oauth-config",
      ok: false,
      message:
        "Missing Google Meet OAuth credentials. Configure oauth.clientId and oauth.refreshToken, or pass --client-id and --refresh-token.",
    });
    return { ok: false, configured: false, checks };
  }

  checks.push({
    id: "oauth-config",
    ok: true,
    message: hasRefreshConfig
      ? "Google Meet OAuth refresh credentials are configured"
      : "Google Meet cached access token is configured",
  });

  let token: Awaited<ReturnType<typeof resolveGoogleMeetAccessToken>>;
  try {
    token = await resolveGoogleMeetAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      accessToken,
      expiresAt,
    });
    checks.push({
      id: "oauth-token",
      ok: true,
      message: token.refreshed
        ? "Refresh token minted an access token"
        : "Cached access token is still valid",
    });
  } catch (error) {
    checks.push({
      id: "oauth-token",
      ok: false,
      message: sanitizeOAuthErrorMessage(error),
    });
    return { ok: false, configured: true, checks };
  }

  const report: OAuthDoctorReport = {
    ok: true,
    configured: true,
    tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
    expiresAt: token.expiresAt,
    checks,
  };

  const meeting = options.meeting?.trim();
  if (meeting) {
    try {
      const space = await fetchGoogleMeetSpace({ accessToken: token.accessToken, meeting });
      checks.push({
        id: "meet-spaces-get",
        ok: true,
        message: `Resolved ${space.name}`,
      });
      report.meetingUri = space.meetingUri;
    } catch (error) {
      checks.push({
        id: "meet-spaces-get",
        ok: false,
        message: sanitizeOAuthErrorMessage(error),
      });
    }
  }

  if (options.createSpace) {
    try {
      const created = await createGoogleMeetSpace({ accessToken: token.accessToken });
      checks.push({
        id: "meet-spaces-create",
        ok: true,
        message: `Created ${created.space.name}`,
      });
      report.createdSpace = created.space.name;
      report.meetingUri = created.meetingUri;
    } catch (error) {
      checks.push({
        id: "meet-spaces-create",
        ok: false,
        message: sanitizeOAuthErrorMessage(error),
      });
    }
  }

  report.ok = checks.every((check) => check.ok);
  return report;
}

function writeOAuthDoctorReport(report: OAuthDoctorReport): void {
  writeStdoutLine("Google Meet OAuth: %s", report.ok ? "OK" : "needs attention");
  writeStdoutLine("configured: %s", report.configured ? "yes" : "no");
  if (report.tokenSource) {
    writeStdoutLine("token source: %s", report.tokenSource);
  }
  if (report.meetingUri) {
    writeStdoutLine("meeting uri: %s", report.meetingUri);
  }
  for (const check of report.checks) {
    writeStdoutLine("[%s] %s: %s", check.ok ? "ok" : "fail", check.id, check.message);
  }
}

export function registerGoogleMeetDoctorCommand(context: GoogleMeetCliCommandContext): void {
  const params = context;
  const { root, callGateway } = context;

  root
    .command("doctor")
    .description("Show human-readable Meet session/browser/realtime health")
    .argument("[session-id]", "Meet session ID")
    .option("--oauth", "Verify Google Meet OAuth token refresh without printing secrets", false)
    .option("--meeting <value>", "Also verify spaces.get for a Meet URL, code, or spaces/{id}")
    .option("--create-space", "Also verify spaces.create by creating a throwaway Meet space", false)
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (sessionId: string | undefined, options: DoctorOptions) => {
      if (options.oauth) {
        const report = await buildOAuthDoctorReport(params.config, options);
        if (options.json) {
          writeStdoutJson(report);
          return;
        }
        writeOAuthDoctorReport(report);
        return;
      }
      const delegated = await callGoogleMeetGateway({
        callGateway,
        method: "googlemeet.status",
        payload: { sessionId },
      });
      if (delegated.ok) {
        const status = delegated.payload as Awaited<ReturnType<GoogleMeetRuntime["status"]>>;
        if (options.json) {
          writeStdoutJson(status);
          return;
        }
        writeDoctorStatus(status);
        return;
      }
      const rt = await params.ensureRuntime();
      const status = await rt.status(sessionId);
      if (options.json) {
        writeStdoutJson(status);
        return;
      }
      writeDoctorStatus(status);
    });
}
