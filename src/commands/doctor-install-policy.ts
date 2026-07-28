/** Doctor checks for install/update security policy configuration and synthetic probes. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  probeInstallPolicy,
  validateInstallPolicyStatic,
  type InstallPolicyStaticValidation,
} from "../security/install-policy.js";

type InstallPolicyHealthOptions = {
  deep?: boolean;
  env?: NodeJS.ProcessEnv;
};

function formatTargets(validation: InstallPolicyStaticValidation): string {
  return validation.targets.length > 0 ? validation.targets.join(", ") : "none";
}

/** Builds doctor note lines for static install policy validation and optional deep probing. */
async function collectInstallPolicyHealthLines(
  cfg: OpenClawConfig,
  options: InstallPolicyHealthOptions = {},
): Promise<string[]> {
  const validation = await validateInstallPolicyStatic(cfg);
  if (!validation.enabled) {
    return [];
  }

  const lines: string[] = [`- Install policy enabled for: ${formatTargets(validation)}`];
  for (const issue of validation.issues) {
    lines.push(`- ${issue.severity.toUpperCase()}: ${issue.message}`);
  }
  if (validation.issues.some((issue) => issue.severity === "error")) {
    lines.push("- Installs and updates for covered targets will fail closed until this is fixed.");
    return lines;
  }

  if (!options.deep) {
    lines.push(
      `- Static checks passed. Run ${formatCliCommand("openclaw doctor --deep")} to execute a synthetic policy probe.`,
    );
    return lines;
  }

  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-policy-probe-"));
  try {
    const result = await probeInstallPolicy({
      config: cfg,
      env: options.env,
      logger: {},
      sourcePath: probeDir,
    });
    if (!result?.blocked) {
      lines.push("- Deep probe allowed the synthetic install request.");
      return lines;
    }
    if (result.blocked.code === "security_scan_blocked") {
      lines.push(
        `- Deep probe reached the policy command and the policy blocked the synthetic request: ${result.blocked.reason}`,
      );
      return lines;
    }
    lines.push(`- ERROR: Deep probe failed closed: ${result.blocked.reason}`);
    lines.push("- Installs and updates for covered targets will fail closed until this is fixed.");
    return lines;
  } catch (err) {
    lines.push(`- ERROR: Deep probe could not run: ${formatErrorMessage(err)}`);
    lines.push("- Installs and updates for covered targets will fail closed until this is fixed.");
    return lines;
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true });
  }
}

/** Emits install policy health notes when policy validation finds configured coverage or errors. */
export async function noteInstallPolicyHealth(
  cfg: OpenClawConfig,
  options: InstallPolicyHealthOptions = {},
): Promise<void> {
  const lines = await collectInstallPolicyHealthLines(cfg, options);
  if (lines.length === 0) {
    return;
  }
  note(lines.join("\n"), "Install policy");
}
