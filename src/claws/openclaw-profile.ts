// Safe loader for the conventional package-local OpenClaw profile.
import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import type { ToolProfileId } from "../agents/tool-policy-shared.js";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { isSafeClawRelativePath } from "./schema-portability.js";
import { parseClawOpenClawProfile } from "./schema.js";
import {
  materializeClawToolProfile,
  resolveClawToolProfileSnapshot,
} from "./tool-profile-consent.js";
import type { ClawDiagnostic, ClawOpenClawProfile } from "./types.js";
import { parseClawYaml } from "./yaml-document.js";

const MAX_PROFILE_BYTES = 256 * 1024;
const CLAW_PROFILE_PATH = "profiles/openclaw.yml";
const LEGACY_PROFILE_POINTER_KEY = "openclaw.config";
const LEGACY_PROFILE_POINTER_PATH = "$.metadata.openclaw.config";
const CONVENTIONAL_PROFILE_PATH = "$.profiles.openclaw";

function diagnostic(code: string, message: string, path = "$"): ClawDiagnostic {
  return { level: "error", code, phase: "parse", path, message };
}

function warning(code: string, message: string, path: string): ClawDiagnostic {
  return { level: "warning", code, phase: "parse", path, message };
}

function isToolProfileId(value: string): value is ToolProfileId {
  return resolveClawToolProfileSnapshot({ profile: value }) !== undefined;
}

function migrateLegacyDynamicToolProfile(value: unknown): {
  value: unknown;
  legacyProfile?: ClawOpenClawProfile;
} {
  const profile = record(value);
  const agent = record(profile?.agent);
  const tools = record(agent?.tools);
  const toolProfile = tools?.profile;
  if (
    !profile ||
    !agent ||
    !tools ||
    typeof toolProfile !== "string" ||
    !isToolProfileId(toolProfile) ||
    tools.allow !== undefined
  ) {
    return { value };
  }
  if (toolProfile === "full") {
    return { value };
  }
  const validationProbe = parseClawOpenClawProfile({
    ...profile,
    agent: {
      ...agent,
      tools: {
        ...tools,
        profile: "minimal",
      },
    },
  });
  if (!validationProbe.ok) {
    return { value };
  }
  const validatedTools = validationProbe.profile.agent.tools;
  if (!validatedTools) {
    return { value };
  }
  const selection = {
    ...validatedTools,
    profile: toolProfile,
  };
  const legacyProfile: ClawOpenClawProfile = {
    ...validationProbe.profile,
    agent: {
      ...validationProbe.profile.agent,
      tools: selection,
    },
  };
  const migrated = materializeClawToolProfile(
    { tools: selection },
    { allowLegacyDynamicProfile: true },
  );
  return {
    value: {
      ...profile,
      agent: {
        ...agent,
        tools: migrated.tools,
      },
    },
    legacyProfile,
  };
}

async function readProfileFile(packageRoot: string, path: string): Promise<Buffer> {
  const packageFiles = await fsSafeRoot(packageRoot);
  const read = await packageFiles.read(path, {
    hardlinks: "reject",
    maxBytes: MAX_PROFILE_BYTES,
    nonBlockingRead: true,
    symlinks: "reject",
  });
  return read.buffer;
}

/**
 * Resolves the OpenClaw profile for a package.
 *
 * `profiles/openclaw.yml` is the conventional location. The retired
 * `metadata.openclaw.config` pointer is still read for compatibility with
 * packages published against the released contract; it reports a deprecation
 * warning instead of failing, and only errors when it is malformed or conflicts
 * with a conventional profile.
 */
export async function readClawOpenClawProfile(params: {
  packageRoot: string;
  metadata?: Record<string, string>;
  allowLegacyDynamicToolProfile?: boolean;
}): Promise<
  | {
      ok: true;
      profile?: ClawOpenClawProfile;
      legacyProfile?: ClawOpenClawProfile;
      raw?: Buffer;
      path?: string;
      diagnostics?: ClawDiagnostic[];
    }
  | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const packageFiles = await fsSafeRoot(params.packageRoot);
  const conventionalExists = await packageFiles.exists(CLAW_PROFILE_PATH);
  const legacyPointer = params.metadata?.[LEGACY_PROFILE_POINTER_KEY];
  const diagnostics: ClawDiagnostic[] = [];
  let declaredPath = CLAW_PROFILE_PATH;
  let diagnosticPath = CONVENTIONAL_PROFILE_PATH;

  if (legacyPointer !== undefined) {
    if (
      legacyPointer.includes("\\") ||
      !isSafeClawRelativePath(legacyPointer) ||
      !/\.ya?ml$/i.test(legacyPointer)
    ) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            "invalid_openclaw_profile_path",
            `metadata.${LEGACY_PROFILE_POINTER_KEY} must reference a forward-slash package-relative .yml or .yaml file.`,
            LEGACY_PROFILE_POINTER_PATH,
          ),
        ],
      };
    }
    if (conventionalExists && legacyPointer !== CLAW_PROFILE_PATH) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            "conflicting_openclaw_profile_pointer",
            `metadata.${LEGACY_PROFILE_POINTER_KEY} references ${legacyPointer} while ${CLAW_PROFILE_PATH} also exists; keep only ${CLAW_PROFILE_PATH}.`,
            LEGACY_PROFILE_POINTER_PATH,
          ),
        ],
      };
    }
    declaredPath = legacyPointer;
    diagnosticPath = LEGACY_PROFILE_POINTER_PATH;
    diagnostics.push(
      warning(
        "deprecated_openclaw_profile_pointer",
        `metadata.${LEGACY_PROFILE_POINTER_KEY} is deprecated; move the profile to ${CLAW_PROFILE_PATH} and remove the metadata entry.`,
        LEGACY_PROFILE_POINTER_PATH,
      ),
    );
  } else if (!conventionalExists) {
    return { ok: true };
  }

  let raw: Buffer;
  try {
    raw = await readProfileFile(params.packageRoot, declaredPath);
  } catch (error) {
    const unsafe =
      error instanceof FsSafeError &&
      (error.code === "hardlink" || error.code === "symlink" || error.code === "path-mismatch");
    const tooLarge = error instanceof FsSafeError && error.code === "too-large";
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          unsafe
            ? "openclaw_profile_unsafe"
            : tooLarge
              ? "openclaw_profile_too_large"
              : "openclaw_profile_read_failed",
          unsafe
            ? "The OpenClaw profile must be a regular, non-symlinked, non-hardlinked file."
            : tooLarge
              ? `The OpenClaw profile exceeds ${MAX_PROFILE_BYTES} bytes.`
              : `Could not read ${declaredPath}: ${(error as Error).message}`,
          diagnosticPath,
        ),
      ],
    };
  }

  const text = raw.toString("utf8");
  const yaml = parseClawYaml(
    text.startsWith("\uFEFF") ? text.slice(1) : text,
    declaredPath,
    "profile",
  );
  if (!yaml.ok) {
    return yaml;
  }
  const migration = params.allowLegacyDynamicToolProfile
    ? migrateLegacyDynamicToolProfile(yaml.value)
    : { value: yaml.value };
  const parsed = parseClawOpenClawProfile(migration.value);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: parsed.diagnostics.map((entry) => ({
        ...entry,
        path: `${diagnosticPath}${entry.path.slice(1)}`,
      })),
    };
  }
  return {
    ok: true,
    profile: parsed.profile,
    ...(migration.legacyProfile ? { legacyProfile: migration.legacyProfile } : {}),
    raw,
    path: declaredPath,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
