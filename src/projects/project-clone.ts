import fs from "node:fs/promises";
import path from "node:path";
import { slugifyWorktreeTitle } from "../agents/worktrees/name.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { cloneProjectCheckout, ProjectCloneError } from "./project-clone-runtime.js";
import { parseProjectGitUrl } from "./project-git-url.js";
import {
  listProjectRegistry,
  registerClonedProjectRegistry,
  type ProjectRegistryRecord,
} from "./project-registry.js";

const PROJECT_CLONE_LEASE_MS = 30_000;
const PROJECT_CLONE_WAIT_MS = 30_000;

function existingCanonicalProject(
  cfg: OpenClawConfig,
  canonicalUrl: string,
  options: OpenClawStateDatabaseOptions,
): ProjectRegistryRecord | undefined {
  return listProjectRegistry(cfg, options).find((project) => {
    const origin = project.originUrl ? parseProjectGitUrl(project.originUrl) : null;
    return origin?.url === canonicalUrl;
  });
}

/** Materializes and registers a project from an accepted GitHub remote. */
export async function materializeProjectClone(
  input: { cfg: OpenClawConfig; gitUrl: string; name?: string },
  options: OpenClawStateDatabaseOptions & {
    signal?: AbortSignal;
    timeoutMs?: number;
    token?: string;
  } = {},
): Promise<ProjectRegistryRecord> {
  const parsed = parseProjectGitUrl(input.gitUrl);
  if (!parsed) {
    throw new ProjectCloneError(
      "invalid_url",
      "Use a GitHub HTTPS or git@github.com repository URL. Local paths and file URLs are not accepted.",
    );
  }
  const existing = existingCanonicalProject(input.cfg, parsed.url, options);
  if (existing) {
    return existing;
  }

  const env = options.env ?? process.env;
  const fingerprint = sha256HexPrefixCore(parsed.url, 16);
  return await withOpenClawStateLease(
    {
      scope: "projects.clone",
      key: fingerprint,
      database: { scope: "shared", options },
      leaseMs: PROJECT_CLONE_LEASE_MS,
      waitMs: PROJECT_CLONE_WAIT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      leaseLabel: "project clone lease",
      operationLabel: "projects.clone.lease",
    },
    async (lease) => {
      const raced = existingCanonicalProject(input.cfg, parsed.url, options);
      if (raced) {
        return raced;
      }
      const displayName = input.name?.trim() || parsed.name;
      const directoryName = slugifyWorktreeTitle(displayName) ?? "project";
      const target = path.join(resolveStateDir(env), "projects", fingerprint, directoryName);
      await cloneProjectCheckout(
        { url: parsed.url, target },
        {
          env,
          signal: lease.signal,
          timeoutMs: options.timeoutMs,
          token: options.token,
        },
      );
      try {
        lease.assertOwned();
        return await registerClonedProjectRegistry(
          { path: target, name: displayName, originUrl: parsed.url },
          options,
        );
      } catch (error) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    },
  );
}

/** Deletes a checkout only when it still occupies its exact managed project slot. */
export async function deleteClonedProjectCheckout(
  project: ProjectRegistryRecord,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  if (project.source !== "cloned") {
    throw new ProjectCloneError(
      "clone_failed",
      "Only projects cloned by the Gateway can delete their checkout.",
    );
  }
  const managedRoot = await fs.realpath(path.join(resolveStateDir(options.env), "projects"));
  const checkout = await fs.realpath(project.repoRoot).catch(() => {
    throw new ProjectCloneError(
      "clone_failed",
      "The managed project checkout is already unavailable. Remove only its registry entry instead.",
    );
  });
  const relative = path.relative(managedRoot, checkout);
  const segments = relative.split(path.sep);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    segments.length !== 2 ||
    !/^[a-f0-9]{16}$/u.test(segments[0] ?? "")
  ) {
    throw new ProjectCloneError(
      "clone_failed",
      "The cloned project is outside the Gateway-managed projects area, so its checkout was not deleted.",
    );
  }
  await fs.rm(checkout, { recursive: true });
  await fs.rmdir(path.dirname(checkout)).catch(() => {});
}
