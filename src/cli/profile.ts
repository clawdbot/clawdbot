// Root --profile/--dev parsing and environment projection for profile-specific state.
import os from "node:os";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { resolveHomeRelativePath, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { isValidProfileName } from "./profile-utils.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

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

function resolveProfileStateDir(
  profile: string,
  env: Record<string, string | undefined>,
  homedir: () => string,
): string {
  const suffix = normalizeLowercaseStringOrEmpty(profile) === "default" ? "" : `-${profile}`;
  return path.join(resolveRequiredHomeDir(env as NodeJS.ProcessEnv, homedir), `.openclaw${suffix}`);
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
  const inheritedProfileStateDir = resolveProfileStateDir(inheritedProfile, env, homedir);
  const selectedProfileStateDir = resolveProfileStateDir(profile, env, homedir);
  const switchesInheritedProfile = inheritedProfileStateDir !== selectedProfileStateDir;
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

  // A service's canonical profile paths are inherited defaults, not custom overrides.
  // Switch them together so an explicit profile cannot mutate the service's profile.
  env.OPENCLAW_PROFILE = profile;

  const stateDir =
    existingStateDir && !switchesInheritedProfileState ? existingStateDir : selectedProfileStateDir;
  if (!existingStateDir || switchesInheritedProfileState) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  if (!existingConfigPath || replacesInheritedProfileConfig) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  if (switchesInheritedProfile) {
    const inheritedSystemdServiceName = resolveGatewaySystemdServiceName(inheritedProfile);
    const inheritedServiceIdentities = {
      OPENCLAW_LAUNCHD_LABEL: [resolveGatewayLaunchAgentLabel(inheritedProfile)],
      OPENCLAW_SYSTEMD_UNIT: [
        inheritedSystemdServiceName,
        `${inheritedSystemdServiceName}.service`,
      ],
      OPENCLAW_WINDOWS_TASK_NAME: [resolveGatewayWindowsTaskName(inheritedProfile)],
    };
    for (const [key, inheritedValues] of Object.entries(inheritedServiceIdentities)) {
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
