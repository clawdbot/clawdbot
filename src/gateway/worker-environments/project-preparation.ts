import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { requireGit } from "../../agents/worktrees/git.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createProjectSeedScript } from "./project-seed-script.js";
import { createProjectSetupScript } from "./project-setup-script.js";
import {
  prepareWorkerWorkspaceGitPack,
  workerProjectSeedKey,
  type WorkerProjectSnapshot,
} from "./workspace-git-base.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";

type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;
type PreparationResult = Awaited<ReturnType<ProjectPreparation["prepare"]>>;

export async function readWorkerProjectSetupRecipe(
  project: WorkerProjectSnapshot,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const tree = await requireGit(
    project.root,
    ["ls-tree", "-z", project.baseCommit, "--", ".openclaw/worktree-setup.sh"],
    { signal, timeoutMs: 30_000 },
  );
  return /^100755 blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t\.openclaw\/worktree-setup\.sh\0$/u.exec(
    tree,
  )?.[1];
}

export function readWorkerProjectSnapshot(value: unknown): WorkerProjectSnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.key) ||
    typeof value.baseCommit !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.baseCommit) ||
    typeof value.root !== "string" ||
    value.root.length > 4096 ||
    !path.isAbsolute(value.root)
  ) {
    throw new Error("Worker environment has an invalid project preparation snapshot");
  }
  return { key: value.key, root: value.root, baseCommit: value.baseCommit };
}

export function createWorkerProjectPreparation(params: {
  project: WorkerProjectSnapshot;
  namespace: string;
  preparation?: {
    key: string;
    cacheKey: string;
    purpose: "session" | "reserve";
    demandAtMs: number;
    setupRecipe?: string;
  };
  setupAuthorized?: boolean;
  requireCurrent: () => void;
  signal?: AbortSignal;
}): {
  project: ProjectPreparation;
  getPreparedWorkspace: () => PreparationResult["preparedWorkspace"];
  close: () => void;
} {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(params.namespace)) {
    throw new Error("Worker project preparation namespace is invalid");
  }
  const preparation = params.preparation;
  if (
    preparation &&
    (!/^[a-f0-9]{64}$/u.test(preparation.key) ||
      !/^[a-f0-9]{64}$/u.test(preparation.cacheKey) ||
      !Number.isSafeInteger(preparation.demandAtMs) ||
      preparation.demandAtMs < 0 ||
      (preparation.setupRecipe !== undefined &&
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(preparation.setupRecipe)))
  ) {
    throw new Error("Worker project preparation identity is invalid");
  }
  if (preparation?.setupRecipe && !params.setupAuthorized) {
    throw new Error("Prepared project setup requires operator.admin authorization");
  }
  const abort = new AbortController();
  // Stop must reach active Git/transport work, not only the next owner check.
  const signal = params.signal ? AbortSignal.any([abort.signal, params.signal]) : abort.signal;
  const seedKey = workerProjectSeedKey(params.project);
  let active: Promise<PreparationResult> | undefined;
  let preparedWorkspace: PreparationResult["preparedWorkspace"];
  const requireCurrent = () => {
    signal.throwIfAborted();
    try {
      params.requireCurrent();
    } catch (error) {
      abort.abort(error);
      throw error;
    }
  };
  const readPreparedWorkspace = (prepared: unknown) => {
    if (!preparation) {
      throw new Error("Project preparation did not request a prepared workspace");
    }
    const suffix = `/.openclaw-worker/prepared/${params.namespace}/${preparation.cacheKey}`;
    if (
      !isRecord(prepared) ||
      typeof prepared.workspaceDir !== "string" ||
      prepared.workspaceDir.length > 4096 ||
      !path.posix.isAbsolute(prepared.workspaceDir) ||
      path.posix.normalize(prepared.workspaceDir) !== prepared.workspaceDir ||
      !prepared.workspaceDir.endsWith(`${suffix}/workspace`) ||
      prepared.homeDir !== path.posix.join(path.posix.dirname(prepared.workspaceDir), "home") ||
      typeof prepared.sourceManifestRef !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(prepared.sourceManifestRef)
    ) {
      throw new Error("Prepared project returned invalid workspace identity");
    }
    return Object.freeze({
      preparationKey: preparation.key,
      cacheKey: preparation.cacheKey,
      workspaceDir: prepared.workspaceDir,
      homeDir: prepared.homeDir,
      sourceManifestRef: prepared.sourceManifestRef,
    });
  };
  const prepareSeed: ProjectPreparation["prepare"] = async (transport) => {
    requireCurrent();
    const scriptInput = {
      namespace: params.namespace,
      seedKey,
      baseCommit: params.project.baseCommit,
      ...(preparation
        ? {
            preparation: {
              preparationKey: preparation.key,
              cacheKey: preparation.cacheKey,
              setupRecipe: preparation.setupRecipe,
            },
          }
        : {}),
    };
    const inspection: unknown = JSON.parse(
      await transport.runScript(createProjectSeedScript(scriptInput), signal),
    );
    requireCurrent();
    if (!isRecord(inspection) || typeof inspection.ready !== "boolean") {
      throw new Error("Project preparation returned invalid seed status");
    }
    if (inspection.ready) {
      return {
        seedKey,
        cacheHit: true,
        ...(inspection.preparedWorkspace !== undefined
          ? { preparedWorkspace: readPreparedWorkspace(inspection.preparedWorkspace) }
          : {}),
      };
    }
    const directory = inspection.directory;
    const retainedCommit = inspection.retainedCommit;
    if (
      retainedCommit !== undefined &&
      (!preparation ||
        typeof retainedCommit !== "string" ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(retainedCommit) ||
        retainedCommit.length !== params.project.baseCommit.length)
    ) {
      throw new Error("Project preparation returned an invalid retained Git base");
    }
    if (
      typeof directory !== "string" ||
      directory.length > 4096 ||
      !path.posix.isAbsolute(directory) ||
      !directory.includes(`/.openclaw-worker/git-seeds/${params.namespace}/`) ||
      path.posix.normalize(directory) !== directory ||
      path.posix.basename(path.posix.dirname(directory)) !== params.namespace ||
      !path.posix.basename(directory).startsWith(`.tmp-${seedKey}-`)
    ) {
      throw new Error("Project preparation returned an invalid staging directory");
    }
    const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-project-base-"));
    try {
      requireCurrent();
      const pack = await prepareWorkerWorkspaceGitPack({
        root: params.project.root,
        baseCommit: params.project.baseCommit,
        ...(typeof retainedCommit === "string" ? { retainedCommit } : {}),
        temporaryRoot,
        signal,
      });
      requireCurrent();
      const bytes = (await fsp.stat(pack)).size;
      if (bytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) {
        throw new Error("Project Git pack exceeds the workspace byte limit");
      }
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(pack, { signal })) {
        hash.update(chunk);
      }
      requireCurrent();
      await transport.upload(pack, path.posix.join(directory, "base.pack"), signal);
      requireCurrent();
      const installed: unknown = JSON.parse(
        await transport.runScript(
          createProjectSeedScript({
            ...scriptInput,
            pack: {
              directory,
              bytes,
              sha256: hash.digest("hex"),
              ...(typeof retainedCommit === "string" ? { retainedCommit } : {}),
            },
          }),
          signal,
        ),
      );
      requireCurrent();
      if (!isRecord(installed) || installed.ready !== true) {
        throw new Error("Project checkout was not verified before capture");
      }
      return { seedKey, cacheHit: false };
    } finally {
      await fsp.rm(temporaryRoot, { recursive: true, force: true });
    }
  };
  const prepare: ProjectPreparation["prepare"] = async (transport) => {
    if (!preparation) {
      const result = await prepareSeed(transport);
      requireCurrent();
      return result;
    }
    if (!transport.runScriptWithBudget) {
      throw new Error("Prepared workspaces require a provider command budget");
    }
    const result = await prepareSeed(transport);
    requireCurrent();
    if (result.preparedWorkspace) {
      preparedWorkspace = result.preparedWorkspace;
      return result;
    }
    // Seed transfer can outlive its caller. Repository code starts only under
    // the current provisioning owner, and never runs in a later session's HOME.
    const prepared: unknown = JSON.parse(
      await transport.runScriptWithBudget(
        (timeoutMs) =>
          createProjectSetupScript({
            namespace: params.namespace,
            seedKey,
            preparationKey: preparation.key,
            cacheKey: preparation.cacheKey,
            baseCommit: params.project.baseCommit,
            setupRecipe: preparation.setupRecipe,
            timeoutMs,
          }),
        signal,
      ),
    );
    requireCurrent();
    preparedWorkspace = readPreparedWorkspace(prepared);
    return { ...result, preparedWorkspace };
  };
  return {
    getPreparedWorkspace: () => preparedWorkspace,
    project: {
      key: params.project.key,
      baseCommit: params.project.baseCommit,
      ...(preparation
        ? {
            preparation: {
              key: preparation.key,
              cacheKey: preparation.cacheKey,
              purpose: preparation.purpose,
              demandAtMs: preparation.demandAtMs,
            },
          }
        : {}),
      signal,
      assertCurrent: requireCurrent,
      prepare: (transport) => {
        requireCurrent();
        return (active ??= prepare(transport));
      },
    },
    close: () =>
      abort.abort(new DOMException("Project preparation operation is closed", "AbortError")),
  };
}
