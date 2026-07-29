// Update status helpers for `openclaw status`.
// Wraps registry/git update checks and formats compact update rows/hints.

import { formatCliCommand } from "../cli/command-format.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  type UpdateCheckResult,
} from "../infra/update-check.js";
import { VERSION } from "../version.js";

/** Runs the update check using the configured update channel and current install root. */
export async function getUpdateCheckResult(params: {
  timeoutMs: number;
  fetchGit: boolean;
  includeRegistry: boolean;
  updateConfigChannel?: string | null;
}): Promise<UpdateCheckResult> {
  const configChannel = normalizeUpdateChannel(params.updateConfigChannel);
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  return await checkUpdateStatus({
    root,
    timeoutMs: params.timeoutMs,
    fetchGit: params.fetchGit,
    includeRegistry: params.includeRegistry,
    registryChannel: resolveRegistryUpdateChannel({
      configChannel,
      currentVersion: VERSION,
    }),
  });
}

type UpdateAvailability = {
  available: boolean;
  hasGitUpdate: boolean;
  hasRegistryUpdate: boolean;
  latestVersion: string | null;
  gitBehind: number | null;
};

/** Determines whether git and/or registry data indicate an available update. */
export function resolveUpdateAvailability(update: UpdateCheckResult): UpdateAvailability {
  const latestVersion = update.registry?.latestVersion ?? null;
  const registryCmp = latestVersion ? compareSemverStrings(VERSION, latestVersion) : null;
  const hasRegistryUpdate = registryCmp != null && registryCmp < 0;
  const gitBehind =
    update.installKind === "git" && typeof update.git?.behind === "number"
      ? update.git.behind
      : null;
  const hasGitUpdate = gitBehind != null && gitBehind > 0;

  return {
    available: hasGitUpdate || hasRegistryUpdate,
    hasGitUpdate,
    hasRegistryUpdate,
    latestVersion: hasRegistryUpdate ? latestVersion : null,
    gitBehind,
  };
}

/** Formats the actionable update hint shown in status footers. */
export function formatUpdateAvailableHint(update: UpdateCheckResult): string | null {
  const availability = resolveUpdateAvailability(update);
  if (!availability.available) {
    return null;
  }

  const details: string[] = [];
  if (availability.hasGitUpdate && availability.gitBehind != null) {
    details.push(`git behind ${availability.gitBehind}`);
  }
  if (availability.hasRegistryUpdate && availability.latestVersion) {
    details.push(`npm ${availability.latestVersion}`);
  }
  const suffix = details.length > 0 ? ` (${details.join(" · ")})` : "";
  return `Update available${suffix}. Run: ${formatCliCommand("openclaw update")}`;
}

/** Formats a compact one-line update summary for overview rows. */
export function formatUpdateOneLiner(update: UpdateCheckResult): string {
  const parts: string[] = [];

  const appendRegistryUpdateSummary = () => {
    const registryLabel =
      update.registry?.tag && update.registry.tag !== "latest"
        ? `npm ${update.registry.tag}`
        : "npm latest";
    if (update.registry?.latestVersion) {
      const cmp = compareSemverStrings(VERSION, update.registry.latestVersion);
      if (cmp === 0) {
        if (update.installKind !== "git") {
          parts.push("up to date");
        }
        // Git installs still show registry latest, but git ahead/behind remains the primary state.
        parts.push(`${registryLabel} ${update.registry.latestVersion}`);
      } else if (cmp != null && cmp < 0) {
        parts.push(
          update.registry.tag && update.registry.tag !== "latest"
            ? `${registryLabel} update ${update.registry.latestVersion}`
            : `npm update ${update.registry.latestVersion}`,
        );
      } else {
        parts.push(
          update.registry.tag === "extended-stable"
            ? `ahead of extended-stable (${update.registry.latestVersion})`
            : `${registryLabel} ${update.registry.latestVersion} (local newer)`,
        );
      }
      return;
    }
    if (update.registry?.error) {
      if (update.registry.reason === "unsupported_git_channel") {
        parts.push("extended-stable requires a package install");
        return;
      }
      if (update.registry.reason === "selector_missing") {
        parts.push("npm extended-stable selector missing");
        return;
      }
      if (update.registry.reason === "selector_query_failed") {
        parts.push("npm extended-stable query failed");
        return;
      }
      if (update.registry.reason === "exact_package_mismatch") {
        parts.push("npm extended-stable exact package verification failed");
        return;
      }
      parts.push(`${registryLabel} unknown`);
    }
  };

  if (update.installKind === "git" && update.git) {
    const branch = update.git.branch ? `git ${update.git.branch}` : "git";
    parts.push(branch);
    if (update.git.upstream) {
      parts.push(`↔ ${update.git.upstream}`);
    }
    if (update.git.dirty === true) {
      parts.push("dirty");
    }
    if (update.git.behind != null && update.git.ahead != null) {
      if (update.git.behind === 0 && update.git.ahead === 0) {
        parts.push("up to date");
      } else if (update.git.behind > 0 && update.git.ahead === 0) {
        parts.push(`behind ${update.git.behind}`);
      } else if (update.git.behind === 0 && update.git.ahead > 0) {
        parts.push(`ahead ${update.git.ahead}`);
      } else if (update.git.behind > 0 && update.git.ahead > 0) {
        parts.push(`diverged (ahead ${update.git.ahead}, behind ${update.git.behind})`);
      }
    }
    if (update.git.fetchOk === false) {
      parts.push("fetch failed");
    }
    appendRegistryUpdateSummary();
  } else {
    parts.push(update.packageManager !== "unknown" ? update.packageManager : "pkg");
    appendRegistryUpdateSummary();
  }

  if (update.deps) {
    if (update.deps.status === "ok") {
      parts.push("deps ok");
    }
    if (update.deps.status === "missing") {
      parts.push("deps missing");
    }
    if (update.deps.status === "stale") {
      parts.push("deps stale");
    }
  }
  return `Update: ${parts.join(" · ")}`;
}
