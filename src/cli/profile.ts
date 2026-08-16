// Root --profile/--dev parsing and environment projection for profile-specific state.
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { isValidProfileName, resolveProfileStateDir } from "./profile-utils.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";
import { isGatewayServiceEnv } from "./update-cli/update-command-service-env.js";

type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  // Root profile flags are stripped before Commander sees argv, except command-local cases.
  let profile: string | null = null;
  let sawDev = false;

  const scanned = scanCliRootOptions(argv, ({ arg, args, index, out }) => {
    if (arg === "--dev") {
      if (resolveCliArgvInvocation(out).primary === "gateway") {
        out.push(arg);
        return { kind: "handled" };
      }
      if (profile && profile !== "dev") {
        return { kind: "error", error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      return { kind: "handled" };
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      const next = args[index + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      const [primary, secondary] = resolveCliArgvInvocation(out).commandPath;
      if (primary === "qa" && secondary === "matrix") {
        out.push(arg);
        if (consumedNext && next !== undefined) {
          out.push(next);
        }
        return { kind: "handled", consumedNext };
      }
      if (sawDev) {
        return { kind: "error", error: "Cannot combine --dev with --profile" };
      }
      if (!value) {
        return { kind: "error", error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          kind: "error",
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      return { kind: "handled", consumedNext };
    }
    return { kind: "pass" };
  });

  if (!scanned.ok) {
    return scanned;
  }

  return { ok: true, profile, argv: scanned.argv };
}

export function applyCliProfileEnv(params: {
  profile: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}) {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const homedir = params.homedir ?? os.homedir;
  const profile = params.profile.trim();
  if (!profile) {
    return;
  }

  const inheritedProfile = normalizeOptionalString(env.OPENCLAW_PROFILE) ?? "default";
  const existingStateDir = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  const existingConfigPath = normalizeOptionalString(env.OPENCLAW_CONFIG_PATH);
  const profileEnv = env as NodeJS.ProcessEnv;
  const inheritedProfileStateDir = resolveProfileStateDir(inheritedProfile, profileEnv, homedir);
  const selectedProfileStateDir = resolveProfileStateDir(profile, profileEnv, homedir);
  const switchesInheritedProfile = inheritedProfileStateDir !== selectedProfileStateDir;
  const inheritedSystemdServiceName = resolveGatewaySystemdServiceName(inheritedProfile);
  const inheritedServiceSelectors = {
    OPENCLAW_LAUNCHD_LABEL: [resolveGatewayLaunchAgentLabel(inheritedProfile)],
    OPENCLAW_SYSTEMD_UNIT: [inheritedSystemdServiceName, `${inheritedSystemdServiceName}.service`],
    OPENCLAW_WINDOWS_TASK_NAME: [resolveGatewayWindowsTaskName(inheritedProfile)],
  };
  const switchesInheritedProfileState = Boolean(
    existingStateDir &&
    switchesInheritedProfile &&
    resolveHomeRelativePath(existingStateDir, {
      env: env as NodeJS.ProcessEnv,
      homedir,
    }) === inheritedProfileStateDir,
  );
  const replacesInheritedProfileConfig = Boolean(
    switchesInheritedProfile &&
    (!existingStateDir || switchesInheritedProfileState) &&
    existingConfigPath &&
    resolveHomeRelativePath(existingConfigPath, {
      env: env as NodeJS.ProcessEnv,
      homedir,
    }) === path.join(inheritedProfileStateDir, "openclaw.json"),
  );
  const inheritedManagedServiceSelectors =
    switchesInheritedProfile &&
    isGatewayServiceEnv(env) &&
    switchesInheritedProfileState &&
    replacesInheritedProfileConfig;

  if (inheritedManagedServiceSelectors) {
    for (const key of GATEWAY_SERVICE_SELECTOR_ENV_KEYS) {
      delete env[key];
    }
  }

  // A service's canonical profile paths are inherited defaults, not custom overrides.
  // Switch them together so an explicit profile cannot mutate the service's profile.
  env.OPENCLAW_PROFILE = profile;

  const retainedStateDir = inheritedManagedServiceSelectors ? undefined : existingStateDir;
  const stateDir =
    retainedStateDir && !switchesInheritedProfileState ? retainedStateDir : selectedProfileStateDir;
  if (!retainedStateDir || switchesInheritedProfileState) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  if (
    !inheritedManagedServiceSelectors &&
    (!existingConfigPath || replacesInheritedProfileConfig)
  ) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  if (switchesInheritedProfile && !inheritedManagedServiceSelectors) {
    for (const [key, inheritedValues] of Object.entries(inheritedServiceSelectors)) {
      const activeValue = normalizeOptionalString(env[key]);
      if (activeValue && inheritedValues.includes(activeValue)) {
        delete env[key];
      }
    }
  }

  if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
}
