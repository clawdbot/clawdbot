import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { VERSION } from "../version.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import {
  loggedConfigWarningFingerprints,
  setBoundedConfigIoWarningEntry,
  warnedFutureTouchedVersions,
} from "./io.state.js";
import type { OpenClawConfig } from "./types.js";
import { shouldWarnOnTouchedVersion } from "./version.js";

export function warnOnConfigMiskeys(raw: unknown, logger: Pick<typeof console, "warn">): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const gateway = (raw as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") {
    return;
  }
  if ("token" in (gateway as Record<string, unknown>)) {
    logger.warn(
      'Config uses "gateway.token". This key is ignored; use "gateway.auth.token" instead.',
    );
  }
}

export function logConfigWarningsOnce(params: {
  configPath: string;
  warnings: Array<{ path: string; message: string }>;
  logger: Pick<typeof console, "warn">;
}): void {
  if (params.warnings.length === 0) {
    loggedConfigWarningFingerprints.delete(params.configPath);
    return;
  }
  const details = params.warnings
    .map(
      (warning) =>
        `- ${sanitizeTerminalText(warning.path || "<root>")}: ${sanitizeTerminalText(warning.message)}`,
    )
    .join("\n");
  const fingerprint = hashConfigRaw(details);
  if (loggedConfigWarningFingerprints.get(params.configPath) === fingerprint) {
    setBoundedConfigIoWarningEntry(loggedConfigWarningFingerprints, params.configPath, fingerprint);
    return;
  }
  setBoundedConfigIoWarningEntry(loggedConfigWarningFingerprints, params.configPath, fingerprint);
  params.logger.warn(`Config warnings:\n${details}`);
}

export function warnIfConfigFromFuture(
  cfg: OpenClawConfig,
  logger: Pick<typeof console, "warn">,
): void {
  const touched = cfg.meta?.lastTouchedVersion;
  if (!touched || !shouldWarnOnTouchedVersion(VERSION, touched)) {
    return;
  }
  if (warnedFutureTouchedVersions.check(touched)) {
    return;
  }
  logger.warn(
    [
      `Your OpenClaw config was written by version ${touched}, but this command is running ${VERSION}.`,
      "Check: `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`.",
      "If unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
    ].join("\n"),
  );
}
