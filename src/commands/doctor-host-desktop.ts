import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { inspectHostDesktop } from "../gateway/desktop/host-source.js";

/** Collects the non-mutating host desktop diagnostic shared by doctor modes. */
export async function collectHostDesktopHealthFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const inspection = await inspectHostDesktop({ config: cfg.desktop?.host });
  return [
    {
      checkId: "core/doctor/host-desktop",
      severity: inspection.status.state === "unavailable" ? "warning" : "info",
      message: inspection.detail,
      path: "desktop.host",
    },
  ];
}

/** Renders the host desktop probe as its own doctor section; no repair is attempted. */
export async function noteHostDesktopHealth(cfg: OpenClawConfig): Promise<void> {
  const [finding] = await collectHostDesktopHealthFindings(cfg);
  if (finding) {
    note(finding.message, "Host desktop");
  }
}
