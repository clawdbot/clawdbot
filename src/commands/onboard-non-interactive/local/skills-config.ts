/**
 * Skills install config mutation for local non-interactive onboarding.
 *
 * The only persisted setting here is the Node package manager used by skill
 * installs; validation stays close to the CLI option handling.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

/** Applies the non-interactive skills install options to the pending config. */
export function applyNonInteractiveSkillsConfig(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
}) {
  const { nextConfig, opts, runtime } = params;
  if (opts.skipSkills) {
    // Preserve existing skill install config when the operator opted out of the
    // skills setup phase for this non-interactive run.
    return nextConfig;
  }

  const nodeManager = opts.nodeManager ?? "npm";
  if (!["npm", "pnpm", "bun"].includes(nodeManager)) {
    runtime.error('Invalid --node-manager. Use "npm", "pnpm", or "bun".');
    runtime.exit(1);
    return nextConfig;
  }
  return {
    ...nextConfig,
    skills: {
      ...nextConfig.skills,
      install: {
        ...nextConfig.skills?.install,
        nodeManager,
      },
    },
  };
}
