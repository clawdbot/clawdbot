import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { inspectHostDesktop } from "../gateway/desktop/host-source.js";
import { runCommandWithTimeout } from "../process/exec-runner.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const SCREEN_SHARING_PORT = 5900;
const SCREEN_SHARING_COMMAND =
  "sudo launchctl enable system/com.apple.screensharing && sudo launchctl kickstart -k system/com.apple.screensharing";
const SCREEN_SHARING_SETTINGS = "System Settings → General → Sharing → Screen Sharing";

function hostDesktopSeverity(
  status: Awaited<ReturnType<typeof inspectHostDesktop>>["status"],
): HealthFinding["severity"] {
  return status.state === "unavailable" ||
    (status.state === "managed" && status.managedState === "failed")
    ? "warning"
    : "info";
}

/** Collects the non-mutating host desktop diagnostic shared by doctor modes. */
export async function collectHostDesktopHealthFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const inspection = await inspectHostDesktop({ config: cfg.desktop?.host });
  return [
    {
      checkId: "core/doctor/host-desktop",
      severity: hostDesktopSeverity(inspection.status),
      message: inspection.detail,
      path: "desktop.host",
    },
  ];
}

/** Renders host desktop health and offers an explicitly confirmed macOS service repair. */
export async function noteHostDesktopHealth(
  cfg: OpenClawConfig,
  deps: {
    platform?: NodeJS.Platform;
    prompter?: Pick<DoctorPrompter, "shouldRepair" | "confirmRuntimeRepair">;
    runCommand?: typeof runCommandWithTimeout;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const inspection = await inspectHostDesktop({ config: cfg.desktop?.host, platform });
  const finding: HealthFinding = {
    checkId: "core/doctor/host-desktop",
    severity: hostDesktopSeverity(inspection.status),
    message: inspection.detail,
    path: "desktop.host",
  };
  note(finding.message, "Host desktop");
  if (
    platform !== "darwin" ||
    cfg.desktop?.host?.enabled !== true ||
    inspection.status.port !== SCREEN_SHARING_PORT ||
    inspection.unavailableReason !== "not-listening"
  ) {
    return;
  }

  note(
    `Repair command: ${SCREEN_SHARING_COMMAND}\nManual path: ${SCREEN_SHARING_SETTINGS}`,
    "Host desktop repair",
  );
  if (!deps.prompter?.shouldRepair) {
    return;
  }
  // Screen Sharing is a macOS system service and may listen beyond loopback.
  // Keep activation explicit; the Gateway itself only connects to 127.0.0.1.
  const approved = await deps.prompter.confirmRuntimeRepair({
    message:
      "Enable macOS Screen Sharing now using sudo launchctl? This system service may accept connections from other network interfaces according to macOS Sharing settings.",
    initialValue: false,
    requiresInteractiveConfirmation: true,
  });
  if (!approved) {
    note(`Enable Screen Sharing manually in ${SCREEN_SHARING_SETTINGS}.`, "Host desktop repair");
    return;
  }

  const runCommand = deps.runCommand ?? runCommandWithTimeout;
  for (const argv of [
    ["sudo", "launchctl", "enable", "system/com.apple.screensharing"],
    ["sudo", "launchctl", "kickstart", "-k", "system/com.apple.screensharing"],
  ]) {
    const result = await runCommand(argv, { timeoutMs: 120_000 });
    if (result.code !== 0) {
      note(
        `Screen Sharing repair failed. Run ${SCREEN_SHARING_COMMAND}, or enable it in ${SCREEN_SHARING_SETTINGS}.`,
        "Host desktop repair",
      );
      return;
    }
  }
  const repaired = await inspectHostDesktop({ config: cfg.desktop.host, platform });
  note(repaired.detail, "Host desktop");
}
