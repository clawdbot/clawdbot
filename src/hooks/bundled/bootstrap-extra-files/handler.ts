// Bootstrap extra files hook injects configured extra files into startup context.
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";
import { loadDeclaredExtraBootstrapFiles } from "./declared-files.js";

const log = createSubsystemLogger("bootstrap-extra-files");

/** Agent-bootstrap hook that appends configured extra files to the session bootstrap set. */
const bootstrapExtraFilesHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  try {
    const { files: extras, diagnostics } = await loadDeclaredExtraBootstrapFiles({
      config: context.cfg,
      workspaceDir: context.workspaceDir,
    });
    if (diagnostics.length > 0) {
      log.debug("skipped extra bootstrap candidates", {
        skipped: diagnostics.length,
        reasons: diagnostics.reduce<Record<string, number>>((counts, item) => {
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
