import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createProjectSeedScript } from "./project-seed-script.js";
import {
  prepareWorkerWorkspaceGitPack,
  workerProjectSeedKey,
  type WorkerProjectSnapshot,
} from "./workspace-git-base.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";

type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;

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
  requireCurrent: () => void;
  signal?: AbortSignal;
}): { project: ProjectPreparation; close: () => void } {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(params.namespace)) {
    throw new Error("Worker project preparation namespace is invalid");
  }
  const abort = new AbortController();
  // Stop must reach active Git/transport work, not only the next owner check.
  const signal = params.signal ? AbortSignal.any([abort.signal, params.signal]) : abort.signal;
  const seedKey = workerProjectSeedKey(params.project);
  let active: Promise<{ seedKey: string; cacheHit: boolean }> | undefined;
  const requireCurrent = () => {
    signal.throwIfAborted();
    try {
      params.requireCurrent();
    } catch (error) {
      abort.abort(error);
      throw error;
    }
  };
  const prepare: ProjectPreparation["prepare"] = async (transport) => {
    requireCurrent();
    const scriptInput = {
      namespace: params.namespace,
      seedKey,
      baseCommit: params.project.baseCommit,
    };
    const inspection: unknown = JSON.parse(
      await transport.runScript(createProjectSeedScript(scriptInput), signal),
    );
    requireCurrent();
    if (!isRecord(inspection) || typeof inspection.ready !== "boolean") {
      throw new Error("Project preparation returned invalid seed status");
    }
    if (inspection.ready) {
      return { seedKey, cacheHit: true };
    }
    const directory = inspection.directory;
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
    const temporaryRoot = await fsp.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-project-base-"),
    );
    try {
      requireCurrent();
      const pack = await prepareWorkerWorkspaceGitPack({
        root: params.project.root,
        baseCommit: params.project.baseCommit,
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
            pack: { directory, bytes, sha256: hash.digest("hex") },
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
  return {
    project: {
      key: params.project.key,
      baseCommit: params.project.baseCommit,
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
