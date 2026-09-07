import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SKILL_LIBRARY_MAX_FILE_BYTES } from "../../packages/gateway-protocol/src/schema/skill-library-constants.js";
import { hasExactOwnKeys } from "./protocol-record.js";

export const WORKER_SKILL_RESOURCE_COMMAND = "openclaw-internal-skill-resources";
export const WORKER_SKILL_RESOURCE_INPUT_MAX_BYTES = 128 * 1024;
export const WORKER_SKILL_RESOURCE_CHUNK_BYTES =
  Math.floor(WORKER_SKILL_RESOURCE_INPUT_MAX_BYTES / 4) * 3;
export const WORKER_SKILL_RESOURCE_FILE_MAX_BYTES = SKILL_LIBRARY_MAX_FILE_BYTES;
// One delivery index precedes the skill bundle's at most sixteen path components.
export const WORKER_SKILL_RESOURCE_PATH_MAX_DEPTH = 17;

type WorkerSkillResourceIdentity = { resourceId: string; identity: string };
export type WorkerSkillResourceOperation =
  | { operation: "discover" }
  | { operation: "init" }
  | (WorkerSkillResourceIdentity & { operation: "cleanup" })
  | (WorkerSkillResourceIdentity & {
      operation: "write";
      path: string;
      offset: number;
      sizeBytes: number;
      sha256: string;
      executable: boolean;
    });

export type WorkerSkillResourceLocator = WorkerSkillResourceIdentity & { root: string };

function isResourceIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & WorkerSkillResourceIdentity {
  return (
    typeof value.resourceId === "string" &&
    value.resourceId.length === 32 &&
    /^[a-f0-9]{32}$/u.test(value.resourceId) &&
    typeof value.identity === "string" &&
    value.identity.length <= 128 &&
    /^\d+:\d+$/u.exec(value.identity)?.[0] === value.identity
  );
}

export function parseWorkerSkillResourceOperation(value: unknown): WorkerSkillResourceOperation {
  if (isRecord(value)) {
    if (
      (value.operation === "init" || value.operation === "discover") &&
      hasExactOwnKeys(value, ["operation"])
    ) {
      return { operation: value.operation };
    }
    if (isResourceIdentity(value)) {
      if (
        value.operation === "cleanup" &&
        hasExactOwnKeys(value, ["operation", "resourceId", "identity"])
      ) {
        return { operation: "cleanup", resourceId: value.resourceId, identity: value.identity };
      }
      if (
        value.operation === "write" &&
        hasExactOwnKeys(value, [
          "operation",
          "resourceId",
          "identity",
          "path",
          "offset",
          "sizeBytes",
          "sha256",
          "executable",
        ]) &&
        typeof value.path === "string" &&
        value.path.length <= 1_024 &&
        value.path.split("/").length <= WORKER_SKILL_RESOURCE_PATH_MAX_DEPTH &&
        value.path
          .split("/")
          .every(
            (part) =>
              part &&
              part !== "." &&
              part !== ".." &&
              !/[\\:\0]/u.test(part) &&
              !/[ .]$/u.test(part) &&
              !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part) &&
              !/^(conin|conout)\$$/iu.test(part),
          ) &&
        typeof value.offset === "number" &&
        Number.isSafeInteger(value.offset) &&
        value.offset >= 0 &&
        typeof value.sizeBytes === "number" &&
        Number.isSafeInteger(value.sizeBytes) &&
        value.sizeBytes >= value.offset &&
        value.sizeBytes <= WORKER_SKILL_RESOURCE_FILE_MAX_BYTES &&
        typeof value.sha256 === "string" &&
        value.sha256.length === 64 &&
        /^[a-f0-9]{64}$/u.test(value.sha256) &&
        typeof value.executable === "boolean"
      ) {
        return {
          operation: "write",
          resourceId: value.resourceId,
          identity: value.identity,
          path: value.path,
          offset: value.offset,
          sizeBytes: value.sizeBytes,
          sha256: value.sha256,
          executable: value.executable,
        };
      }
    }
  }
  throw new Error("INVALID_REQUEST: invalid worker skill resource operation");
}

export function validateWorkerSkillResourceInput(
  operation: WorkerSkillResourceOperation,
  input: string | undefined,
): void {
  if (operation.operation !== "write") {
    if (input === undefined) {
      return;
    }
  } else if (input !== undefined && input.length <= WORKER_SKILL_RESOURCE_INPUT_MAX_BYTES) {
    const bytes = Buffer.from(input, "base64");
    if (
      bytes.toString("base64") === input &&
      operation.offset + bytes.length <= operation.sizeBytes
    ) {
      return;
    }
  }
  throw new Error("INVALID_REQUEST: invalid worker skill resource chunk");
}

/** Transport bounds reply bytes; delivery validates the exact workspace-owned root. */
export function parseWorkerSkillResourceLocator(value: unknown): WorkerSkillResourceLocator {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, ["resourceId", "identity", "root"]) ||
    !isResourceIdentity(value) ||
    typeof value.root !== "string" ||
    value.root.includes("\0") ||
    (!path.posix.isAbsolute(value.root) && !path.win32.isAbsolute(value.root))
  ) {
    throw new Error("Invalid skill resource location from execution environment.");
  }
  return { resourceId: value.resourceId, identity: value.identity, root: value.root };
}

/** Resource artifacts live beside the project and retire with their exact generation. */
export function parseWorkerSkillResourceGeneration(name: string): number | undefined {
  const match = /^\.(0|[1-9]\d*)\.skill-resources-[a-f0-9]{32}$/u.exec(name);
  if (!match || match[0] !== name) {
    return undefined;
  }
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) ? generation : undefined;
}
