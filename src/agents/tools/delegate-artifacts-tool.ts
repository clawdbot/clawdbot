import fs from "node:fs";
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { resolveContinuationRuntimeConfig } from "../../auto-reply/continuation/config.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openRootFile, readFileDescriptorBounded } from "../../infra/boundary-file-read.js";
import { root } from "../../infra/fs-safe.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import {
  DELEGATE_ARTIFACT_MAX_COUNT,
  DELEGATE_ARTIFACT_MAX_BYTES,
  DELEGATE_ARTIFACT_MAX_TOTAL_BYTES,
  DELEGATE_ARTIFACT_OUTPUT_ROOT,
  discardDelegateArtifactForRecipient,
  inspectDelegateArtifactForRecipient,
  listDelegateArtifactsForRecipient,
  markDelegateArtifactMaterialized,
  publishDelegateArtifactCandidates,
  readDelegateArtifactForMaterialization,
} from "../delegate-artifacts.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const PublishSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1,
      maxItems: DELEGATE_ARTIFACT_MAX_COUNT,
    }),
  },
  { additionalProperties: false },
);

const OperationsSchema = Type.Object(
  {
    action: stringEnum(["list", "inspect", "materialize", "discard"] as const),
    claimId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    destination: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

function safeRelativeSegments(value: string): string[] | undefined {
  if (
    path.isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return undefined;
  }
  const segments = value.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments;
}

function resolveSandboxHostPath(
  sandbox: { root: string; bridge: SandboxFsBridge },
  filePath: string,
): string {
  const hostPath = sandbox.bridge.resolvePath({ filePath }).hostPath;
  if (!hostPath) {
    throw new Error("sandbox host path unavailable");
  }
  return hostPath;
}

function sniffTextMime(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text/plain";
  } catch {
    return undefined;
  }
}

async function readPublicationCandidate(params: {
  workspaceDir: string;
  value: string;
  maxBytes: number;
  sandbox?: { root: string; bridge: SandboxFsBridge };
}) {
  const { value } = params;
  const segments = safeRelativeSegments(value);
  if (!segments) {
    throw new Error("candidate rejected");
  }
  const outputRoot = params.sandbox
    ? resolveSandboxHostPath(
        params.sandbox,
        path.join(params.sandbox.root, DELEGATE_ARTIFACT_OUTPUT_ROOT),
      )
    : path.join(params.workspaceDir, DELEGATE_ARTIFACT_OUTPUT_ROOT);
  const candidatePath = params.sandbox
    ? resolveSandboxHostPath(
        params.sandbox,
        path.join(params.sandbox.root, DELEGATE_ARTIFACT_OUTPUT_ROOT, ...segments),
      )
    : path.join(outputRoot, ...segments);
  const opened = await openRootFile({
    absolutePath: candidatePath,
    rootPath: outputRoot,
    boundaryLabel: "delegate artifact output root",
    maxBytes: params.maxBytes,
    rejectHardlinks: true,
    allowedType: "file",
  });
  if (!opened.ok || opened.stat.size <= 0) {
    throw new Error("candidate rejected");
  }
  try {
    const before = fs.fstatSync(opened.fd);
    const bytes = await readFileDescriptorBounded(opened.fd, params.maxBytes);
    const after = fs.fstatSync(opened.fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== before.size
    ) {
      throw new Error("candidate rejected");
    }
    const mimeType =
      (await detectMime({ buffer: bytes })) ?? sniffTextMime(bytes) ?? "application/octet-stream";
    return { bytes, mimeType };
  } finally {
    fs.closeSync(opened.fd);
  }
}

async function materializeToSafeDestination(params: {
  workspaceDir: string;
  destination: string;
  bytes: Uint8Array;
  sandbox?: { root: string; bridge: SandboxFsBridge };
  sandboxWritable?: boolean;
}): Promise<string> {
  const segments = safeRelativeSegments(params.destination);
  if (!segments || segments.length < 1) {
    throw new Error("destination rejected");
  }
  if (params.sandbox && !params.sandboxWritable) {
    throw new Error("sandbox workspace is read-only");
  }
  const workspaceRoot = params.sandbox
    ? resolveSandboxHostPath(params.sandbox, params.sandbox.root)
    : params.workspaceDir;
  const workspace = await root(workspaceRoot, {
    hardlinks: "reject",
    symlinks: "reject",
    mkdir: false,
    mode: 0o600,
  });
  await workspace.create(segments.join("/"), Buffer.from(params.bytes), {
    mkdir: false,
    mode: 0o600,
  });
  return segments.join("/");
}

async function removeMaterializedDestination(params: {
  workspaceDir: string;
  destination: string;
  sandbox?: { root: string; bridge: SandboxFsBridge };
}): Promise<void> {
  const segments = safeRelativeSegments(params.destination);
  if (!segments) {
    throw new Error("destination cleanup rejected");
  }
  const workspaceRoot = params.sandbox
    ? resolveSandboxHostPath(params.sandbox, params.sandbox.root)
    : params.workspaceDir;
  const workspace = await root(workspaceRoot, {
    hardlinks: "reject",
    symlinks: "reject",
    mkdir: false,
    mode: 0o600,
  });
  await workspace.remove(segments.join("/"));
}

export function createDelegateArtifactTools(options: {
  config?: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  resolveSessionId?: (config: OpenClawConfig, sessionKey: string) => string | undefined;
  agentSessionKey?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
  sandboxWritable?: boolean;
  stateOptions?: OpenClawStateDatabaseOptions;
}): AnyAgentTool[] {
  const resolveCurrentConfig = options.getRuntimeConfig ?? getRuntimeConfig;
  const resolveCurrentSessionId =
    options.resolveSessionId ??
    ((config: OpenClawConfig, sessionKey: string) => {
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      return loadSessionEntry({
        agentId,
        sessionKey,
        storePath: resolveSessionStorePathCore(config.session?.store, { agentId }),
        readConsistency: "latest",
        hydrateSkillPromptRefs: false,
      })?.sessionId;
    });
  const sandbox =
    options.sandboxRoot && options.sandboxFsBridge
      ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
      : undefined;
  const publishTool: AnyAgentTool = {
    label: "Publish delegate artifacts",
    name: "delegate_artifacts_publish",
    description:
      `Publish regular files created by this delegate under ${DELEGATE_ARTIFACT_OUTPUT_ROOT}. ` +
      "Paths are relative to that output root. The host retains private bytes and returns only a typed outcome.",
    parameters: PublishSchema,
    execute: async (toolCallId, args) => {
      if (!isRecord(args)) {
        throw new ToolInputError("delegate_artifacts_publish arguments must be an object.");
      }
      const input = args;
      if (
        !options.agentSessionKey ||
        !options.sessionId ||
        !options.runId ||
        !options.workspaceDir
      ) {
        return jsonResult({ status: "rejected", reason: "forbidden" });
      }
      if (
        !Array.isArray(input.paths) ||
        input.paths.length === 0 ||
        input.paths.length > DELEGATE_ARTIFACT_MAX_COUNT ||
        input.paths.some((entry) => typeof entry !== "string")
      ) {
        throw new ToolInputError("paths must be a bounded list of relative candidate paths.");
      }
      const currentConfig = resolveCurrentConfig();
      const runtime = resolveContinuationRuntimeConfig(currentConfig);
      if (!runtime.enabled) {
        return jsonResult({ status: "rejected", reason: "runtime_disabled" });
      }
      if (resolveCurrentSessionId(currentConfig, options.agentSessionKey) !== options.sessionId) {
        return jsonResult({ status: "rejected", reason: "forbidden" });
      }
      let candidates: Awaited<ReturnType<typeof readPublicationCandidate>>[];
      try {
        candidates = [];
        let totalBytes = 0;
        for (const candidate of input.paths) {
          const maxBytes = Math.min(
            DELEGATE_ARTIFACT_MAX_BYTES,
            DELEGATE_ARTIFACT_MAX_TOTAL_BYTES - totalBytes,
          );
          if (maxBytes <= 0) {
            throw new Error("candidate rejected");
          }
          const publication = await readPublicationCandidate({
            workspaceDir: options.workspaceDir,
            value: candidate,
            maxBytes,
            sandbox,
          });
          candidates.push(publication);
          totalBytes += publication.bytes.byteLength;
        }
      } catch {
        return jsonResult({ status: "rejected", reason: "invalid_candidate" });
      }
      const commitConfig = resolveCurrentConfig();
      const commitRuntime = resolveContinuationRuntimeConfig(commitConfig);
      if (!commitRuntime.enabled) {
        return jsonResult({ status: "rejected", reason: "runtime_disabled" });
      }
      if (resolveCurrentSessionId(commitConfig, options.agentSessionKey) !== options.sessionId) {
        return jsonResult({ status: "rejected", reason: "forbidden" });
      }
      const result = publishDelegateArtifactCandidates({
        producerSessionKey: options.agentSessionKey,
        producerSessionId: options.sessionId,
        producerRunId: options.runId,
        publicationKey: toolCallId,
        candidates,
        runtimeEnabled: commitRuntime.enabled,
        crossSessionEnabled: commitRuntime.crossSessionTargeting !== "disabled",
        options: options.stateOptions,
      });
      return jsonResult(result);
    },
  };

  const operationsTool: AnyAgentTool = {
    label: "Delegate artifacts",
    name: "delegate_artifacts",
    description:
      "List or inspect artifact claims authorized for this session, materialize one to a safe workspace-relative destination, or discard it. Claim IDs are not bearer credentials.",
    parameters: OperationsSchema,
    execute: async (_toolCallId, args) => {
      if (!options.agentSessionKey || !options.sessionId || !options.workspaceDir) {
        return jsonResult({ outcome: "unauthorized" });
      }
      if (!isRecord(args)) {
        throw new ToolInputError("delegate_artifacts arguments must be an object.");
      }
      const input = args;
      const currentConfig = resolveCurrentConfig();
      const runtime = resolveContinuationRuntimeConfig(currentConfig);
      if (resolveCurrentSessionId(currentConfig, options.agentSessionKey) !== options.sessionId) {
        return jsonResult({ outcome: "unauthorized" });
      }
      const crossSessionEnabled = runtime.crossSessionTargeting !== "disabled";
      if (input.action === "list") {
        return jsonResult(
          listDelegateArtifactsForRecipient({
            recipientSessionKey: options.agentSessionKey,
            recipientSessionId: options.sessionId,
            runtimeEnabled: runtime.enabled,
            crossSessionEnabled,
            options: options.stateOptions,
          }),
        );
      }
      if (typeof input.claimId !== "string" || !input.claimId.trim()) {
        throw new ToolInputError("claimId is required for this action.");
      }
      const claimId = input.claimId.trim();
      if (input.action === "inspect") {
        return jsonResult(
          inspectDelegateArtifactForRecipient({
            claimId,
            recipientSessionKey: options.agentSessionKey,
            recipientSessionId: options.sessionId,
            runtimeEnabled: runtime.enabled,
            crossSessionEnabled,
            options: options.stateOptions,
          }),
        );
      }
      if (input.action === "discard") {
        return jsonResult(
          discardDelegateArtifactForRecipient({
            claimId,
            recipientSessionKey: options.agentSessionKey,
            recipientSessionId: options.sessionId,
            runtimeEnabled: runtime.enabled,
            crossSessionEnabled,
            options: options.stateOptions,
          }),
        );
      }
      if (input.action !== "materialize" || typeof input.destination !== "string") {
        throw new ToolInputError("materialize requires a workspace-relative destination.");
      }
      const resolved = readDelegateArtifactForMaterialization({
        claimId,
        recipientSessionKey: options.agentSessionKey,
        recipientSessionId: options.sessionId,
        runtimeEnabled: runtime.enabled,
        crossSessionEnabled,
        options: options.stateOptions,
      });
      if (resolved.outcome !== "available") {
        return jsonResult({ outcome: resolved.outcome });
      }
      let destination: string;
      try {
        destination = await materializeToSafeDestination({
          workspaceDir: options.workspaceDir,
          destination: input.destination,
          bytes: resolved.bytes,
          sandbox,
          sandboxWritable: options.sandboxWritable,
        });
      } catch {
        return jsonResult({ outcome: "unauthorized" });
      }
      const commitConfig = resolveCurrentConfig();
      const commitRuntime = resolveContinuationRuntimeConfig(commitConfig);
      const currentSessionId = resolveCurrentSessionId(commitConfig, options.agentSessionKey);
      const sessionMatches = currentSessionId === options.sessionId;
      const committed = markDelegateArtifactMaterialized({
        claimId,
        recipientSessionKey: options.agentSessionKey,
        recipientSessionId: options.sessionId,
        runtimeEnabled: commitRuntime.enabled && sessionMatches,
        crossSessionEnabled: commitRuntime.crossSessionTargeting !== "disabled",
        destination,
        options: options.stateOptions,
      });
      if (committed.outcome !== "available") {
        try {
          await removeMaterializedDestination({
            workspaceDir: options.workspaceDir,
            destination: input.destination,
            sandbox,
          });
        } catch {
          throw new Error("delegate artifact materialization cleanup failed");
        }
      }
      return jsonResult(
        committed.outcome === "available"
          ? { outcome: "available", materialized: true }
          : committed,
      );
    },
  };

  return [publishTool, operationsTool];
}
