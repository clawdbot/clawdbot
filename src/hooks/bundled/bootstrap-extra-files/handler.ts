// Bootstrap extra files hook injects configured extra files into startup context.
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { loadExtraBootstrapFilesWithDiagnostics } from "../../../agents/workspace.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const HOOK_KEY = "bootstrap-extra-files";
const log = createSubsystemLogger("bootstrap-extra-files");

/** Resolve legacy and current config keys for extra bootstrap file patterns. */
function resolveExtraBootstrapPatterns(hookConfig: Record<string, unknown>): string[] {
  const fromPaths = normalizeTrimmedStringList(hookConfig.paths);
  if (fromPaths.length > 0) {
    return fromPaths;
  }
  const fromPatterns = normalizeTrimmedStringList(hookConfig.patterns);
  if (fromPatterns.length > 0) {
    return fromPatterns;
  }
  return normalizeTrimmedStringList(hookConfig.files);
}

/** Agent-bootstrap hook that appends configured extra files to the session bootstrap set. */
const bootstrapExtraFilesHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return;
  }

  const patterns = resolveExtraBootstrapPatterns(hookConfig as Record<string, unknown>);
  if (patterns.length === 0) {
    return;
  }

  try {
    const { files: extras, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(
      context.workspaceDir,
      patterns,
    );
    // Real faults (glob I/O error, or a pattern escaping workspace containment /
    // rejected by the read guard) must reach the operator; the default info log
    // level hides debug, so surface them at warn with the offending paths. Benign
    // noise (optional literal absent, non-bootstrap basename matched by a broad
    // glob) stays at debug to avoid alarming operators over normal skips.
    const failures = diagnostics.filter((d) => d.reason === "io" || d.reason === "security");
    const benign = diagnostics.filter((d) => d.reason !== "io" && d.reason !== "security");
    if (failures.length > 0) {
      log.warn(
        `bootstrap extra-file resolution failed for ${failures.length} configured pattern(s)`,
        {
          failed: failures.length,
          reasons: {
            io: failures.filter((d) => d.reason === "io").length,
            security: failures.filter((d) => d.reason === "security").length,
          },
          paths: failures.map((d) => d.path),
          hint: "check hook bootstrap paths, workspace containment, and file permissions",
        },
      );
    }
    if (benign.length > 0) {
      log.debug("skipped extra bootstrap candidates", {
        skipped: benign.length,
        reasons: benign.reduce<Record<string, number>>((counts, item) => {
          counts[item.reason] = (counts[item.reason] ?? 0) + 1;
          return counts;
        }, {}),
      });
    }
    if (extras.length === 0) {
      return;
    }
    // The final bootstrap resolver owns session policy after every hook has run,
    // using the authoritative chat type and loader provenance in one place.
    context.bootstrapFiles = [...context.bootstrapFiles, ...extras];
  } catch (err) {
    log.warn(`failed: ${String(err)}`);
  }
};

export default bootstrapExtraFilesHook;
