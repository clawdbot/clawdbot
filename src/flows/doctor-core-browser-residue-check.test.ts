import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import type { HealthRepairContext } from "./health-checks.js";

const browserMocks = vi.hoisted(() => ({
  detectLegacyClawdBrowserProfileResidue: vi.fn(),
  maybeArchiveLegacyClawdBrowserProfileResidue: vi.fn(),
  noteChromeMcpBrowserReadiness: vi.fn(),
}));

vi.mock("../commands/doctor-browser.js", () => ({
  detectLegacyClawdBrowserProfileResidue: browserMocks.detectLegacyClawdBrowserProfileResidue,
  maybeArchiveLegacyClawdBrowserProfileResidue:
    browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue,
  noteChromeMcpBrowserReadiness: browserMocks.noteChromeMcpBrowserReadiness,
}));

const residue = {
  legacyProfileDir: "/tmp/openclaw-home/browser/clawd",
  legacyUserDataDir: "/tmp/openclaw-home/browser/clawd/user-data",
  canonicalUserDataDir: "/tmp/openclaw-home/browser/openclaw/user-data",
};

function runtime() {
  return { log() {}, error() {}, exit() {} };
}

function requireBrowserResidueCheck() {
  const check = CORE_HEALTH_CHECKS.find(
    (entry) => entry.id === "core/doctor/browser-clawd-profile-residue",
  );
  if (!check) {
    throw new Error("expected browser clawd profile residue health check");
  }
  return check;
}

describe("browser clawd profile residue health check", () => {
  beforeEach(() => {
    browserMocks.detectLegacyClawdBrowserProfileResidue.mockReset();
    browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockReset();
    browserMocks.noteChromeMcpBrowserReadiness.mockReset();
  });

  it("reports legacy clawd profile residue through doctor lint", async () => {
    browserMocks.detectLegacyClawdBrowserProfileResidue.mockResolvedValueOnce(residue);
    const cfg: OpenClawConfig = { browser: { profiles: { openclaw: { color: "#FF4500" } } } };
    const check = requireBrowserResidueCheck();

    const findings = await check.detect({
      mode: "lint",
      runtime: runtime(),
      cfg,
      configPath: "/tmp/openclaw-home/openclaw.json",
    });

    expect(browserMocks.detectLegacyClawdBrowserProfileResidue).toHaveBeenCalledWith(cfg, {
      configDir: "/tmp/openclaw-home",
    });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/browser-clawd-profile-residue",
        severity: "warning",
        path: residue.legacyProfileDir,
        ocPath: "oc://state/browser/clawd",
      }),
    ]);
  });

  it("archives legacy clawd profile residue through structured repair", async () => {
    browserMocks.detectLegacyClawdBrowserProfileResidue.mockResolvedValue(residue);
    browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockResolvedValueOnce({
      changes: ["Archived legacy clawd managed browser profile residue."],
      warnings: [],
    });
    const cfg: OpenClawConfig = { browser: { profiles: { openclaw: { color: "#FF4500" } } } };
    const check = requireBrowserResidueCheck();
    const ctx: HealthRepairContext = {
      mode: "fix",
      runtime: runtime(),
      cfg,
      configPath: "/tmp/openclaw-home/openclaw.json",
    };

    const result = await check.repair?.(ctx, []);

    expect(browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue).toHaveBeenCalledWith(cfg, {
      configDir: "/tmp/openclaw-home",
    });
    expect(result).toMatchObject({
      changes: ["Archived legacy clawd managed browser profile residue."],
      effects: [
        {
          kind: "state",
          action: "archive-legacy-browser-profile-residue",
          target: residue.legacyProfileDir,
          dryRunSafe: false,
        },
      ],
    });
  });

  it("supports dry-run repair without archiving the profile", async () => {
    browserMocks.detectLegacyClawdBrowserProfileResidue.mockResolvedValue(residue);
    const check = requireBrowserResidueCheck();

    const result = await check.repair?.(
      {
        mode: "fix",
        runtime: runtime(),
        cfg: {},
        configPath: "/tmp/openclaw-home/openclaw.json",
        dryRun: true,
      },
      [],
    );

    expect(browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue).not.toHaveBeenCalled();
    expect(result?.changes.join("\n")).toContain("Would archive legacy clawd");
    expect(result?.effects).toEqual([
      expect.objectContaining({
        action: "would-archive-legacy-browser-profile-residue",
        target: residue.legacyProfileDir,
      }),
    ]);
  });
});
