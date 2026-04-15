import { describe, expect, it } from "vitest";
import { collectBrowserSecurityAuditFindings } from "./security-audit.js";

function collectFindings(
  config: Parameters<typeof collectBrowserSecurityAuditFindings>[0]["config"],
) {
  return collectBrowserSecurityAuditFindings({
    config,
    sourceConfig: config,
    env: {} as NodeJS.ProcessEnv,
    stateDir: "/tmp/openclaw-state",
    configPath: "/tmp/openclaw.json",
  });
}

describe("browser security audit collector", () => {
  it("flags browser control without auth", () => {
    const findings = collectFindings({
      gateway: {
        controlUi: { enabled: false },
        auth: {},
      },
      browser: {
        enabled: true,
      },
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "browser.control_no_auth",
          severity: "critical",
        }),
      ]),
    );
  });

  it("warns on remote http CDP profiles", () => {
    const findings = collectFindings({
      browser: {
        profiles: {
          remote: {
            cdpUrl: "http://example.com:9222",
            color: "#0066CC",
          },
        },
      },
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "browser.remote_cdp_http",
          severity: "warn",
        }),
      ]),
    );
  });

  it("redacts private-host CDP URLs in findings", () => {
    const findings = collectFindings({
      browser: {
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
        profiles: {
          remote: {
            cdpUrl:
              "http://169.254.169.254:9222/json/version?token=supersecrettokenvalue1234567890",
            color: "#0066CC",
          },
        },
      },
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "browser.remote_cdp_private_host",
          severity: "warn",
          detail: expect.stringContaining("token=supers…7890"),
        }),
      ]),
    );
  });
});
