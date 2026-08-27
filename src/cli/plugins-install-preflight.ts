// Resolve and validate plugin install requests without opening mutable runtime state.
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import { resolveMarketplaceInstallShortcut } from "../plugins/marketplace.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { NON_CLAWHUB_INSTALL_FORCE_FLAG } from "./non-clawhub-install-acknowledgement.js";
import {
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "./plugin-install-config-policy.js";
import { resolvePluginInstallSourcePlan } from "./plugin-install-plan.js";

export type RunPluginInstallCommandParams = {
  raw: string;
  allowInstallPolicyWarningPrompt: boolean;
  opts: InstallSafetyOverrides & {
    acceptCapabilities?: boolean;
    acknowledgeClawHubRisk?: boolean;
    acknowledgeInstallPolicyWarning?: boolean;
    expectedIntegrity?: string;
    expectedPluginId?: string;
    force?: boolean;
    link?: boolean;
    pin?: boolean;
    marketplace?: string;
  };
  invalidateRuntimeCache?: boolean;
  clawManaged?: boolean;
  runtime?: RuntimeEnv;
};

type ResolvedPluginInstallSourcePlan = Extract<
  ReturnType<typeof resolvePluginInstallSourcePlan>,
  { ok: true }
>;

type ResolvedPluginInstallRequest = {
  raw: string;
  opts: RunPluginInstallCommandParams["opts"];
  installMode: "install" | "update";
  request: PluginInstallRequestContext;
};

export type PluginInstallPreflight =
  | { ok: false; error: string }
  | (ResolvedPluginInstallRequest & {
      ok: true;
      sourcePlan: ResolvedPluginInstallSourcePlan;
      marketplace?: never;
    })
  | (ResolvedPluginInstallRequest & {
      ok: true;
      sourcePlan: null;
      marketplace: string;
    });

function resolveMarketplaceOptionError(opts: RunPluginInstallCommandParams["opts"]): string | null {
  if (opts.link) {
    return `--link is not supported with --marketplace. Remove --link, or install a local path with ${formatCliCommand(`openclaw plugins install --link <path> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`;
  }
  if (opts.pin) {
    return `--pin is not supported with --marketplace. Use ${formatCliCommand(`openclaw plugins install <plugin> --marketplace <name> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)} without --pin.`;
  }
  return null;
}

function resolveSourceOptionError(
  opts: RunPluginInstallCommandParams["opts"],
  sourcePlan: ResolvedPluginInstallSourcePlan,
): string | null {
  if (sourcePlan.request.source === "git" && opts.link) {
    return `--link is not supported with git: installs. Use ${formatCliCommand(`openclaw plugins install git:<repo>@<ref> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)} for Git installs or ${formatCliCommand(`openclaw plugins install --link <path> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)} for local paths.`;
  }
  if (sourcePlan.request.source === "git" && opts.pin) {
    return `--pin is not supported with git: installs. Pin the ref in the spec instead, for example ${formatCliCommand(`openclaw plugins install git:<repo>@<ref> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`;
  }
  if (
    opts.pin &&
    sourcePlan.request.source !== "npm" &&
    sourcePlan.request.source !== "official" &&
    sourcePlan.request.source !== "bundled"
  ) {
    return "--pin is only supported with npm registry installs.";
  }
  if (opts.link && sourcePlan.request.source !== "local") {
    return `--link requires a local path. Run ${formatCliCommand(`openclaw plugins install --link <path> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`;
  }
  return null;
}

/** Complete source and option validation before acquiring the persistent lifecycle lease. */
export async function resolvePluginInstallPreflight(
  params: RunPluginInstallCommandParams,
): Promise<PluginInstallPreflight> {
  if (!params.raw.trim()) {
    return { ok: false, error: "Plugin install source must not be empty." };
  }
  if (params.opts.marketplace !== undefined && !params.opts.marketplace.trim()) {
    return { ok: false, error: "--marketplace requires a non-empty source." };
  }

  // Linked paths confirm provenance with --force without changing their copy/update mode.
  const installMode = params.opts.force && !params.opts.link ? "update" : "install";
  let raw = params.raw;
  let marketplace = params.opts.marketplace;
  let sourcePlan: ResolvedPluginInstallSourcePlan | null = null;

  if (marketplace === undefined) {
    // A registered marketplace owns plugin@marketplace before npm/git source classification.
    const shorthand = await tracePluginLifecyclePhaseAsync(
      "marketplace shortcut resolution",
      () => resolveMarketplaceInstallShortcut(raw),
      { command: "install" },
    );
    if (shorthand?.ok === false) {
      return { ok: false, error: shorthand.error };
    }
    if (shorthand?.ok) {
      raw = shorthand.plugin;
      marketplace = shorthand.marketplaceSource;
    } else {
      const planned = resolvePluginInstallSourcePlan({
        raw,
        mode: installMode,
        link: params.opts.link,
        pin: params.opts.pin,
      });
      if (!planned.ok) {
        return planned;
      }
      sourcePlan = planned;
    }
  }

  const opts = { ...params.opts, marketplace };
  const optionError = marketplace
    ? resolveMarketplaceOptionError(opts)
    : sourcePlan
      ? resolveSourceOptionError(opts, sourcePlan)
      : "Plugin install source could not be resolved.";
  if (optionError) {
    return { ok: false, error: optionError };
  }

  const requestResolution = resolvePluginInstallRequestContext({ rawSpec: raw, marketplace });
  if (!requestResolution.ok) {
    return requestResolution;
  }
  const source = sourcePlan?.request.source;
  const request =
    source && ["npm-pack", "git", "clawhub", "bundled", "official"].includes(source)
      ? { ...requestResolution.request, installKind: "plugin" as const }
      : requestResolution.request;

  if (marketplace) {
    return { ok: true, raw, opts, installMode, request, marketplace, sourcePlan: null };
  }
  if (!sourcePlan) {
    return { ok: false, error: "Plugin install source could not be resolved." };
  }
  return { ok: true, raw, opts, installMode, request, sourcePlan };
}
