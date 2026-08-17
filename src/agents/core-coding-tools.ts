import path from "node:path";
import type { SkillSnapshot } from "../skills/types.js";
import { bindAgentToolActionDescriptor } from "./agent-tool-metadata.js";
import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  resolveAdaptiveReadMaxBytes,
  type SkillInstructionDeliveryCache,
  wrapReadToolWithSkillContent,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createApplyPatchTool } from "./apply-patch.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type { ProcessToolDefaults } from "./bash-tools.process.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import { createLazyProcessTool } from "./lazy-process-tool.js";
import type { MemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import type { SandboxContext } from "./sandbox.js";
import { buildSandboxFsMounts } from "./sandbox/fs-paths.js";
import { resolveReadOnlyWorkspaceSkillMounts } from "./sandbox/workspace-mounts.js";
import type {
  createEditTool,
  createReadTool as CreateReadTool,
  createWriteTool,
} from "./sessions/tools/index.js";
import { createReadTool } from "./sessions/tools/read.js";

function sandboxReadMounts(
  sandbox: SandboxContext,
): Array<{ containerRoot: string; hostRoot: string }> | undefined {
  const mounts = buildSandboxFsMounts(sandbox)
    .filter((mount) => mount.source !== "workspace")
    .map((mount) => ({ containerRoot: mount.containerRoot, hostRoot: mount.hostRoot }));
  return mounts.length > 0 ? mounts : undefined;
}

function resolveSkillReadRoots(skillsSnapshot?: SkillSnapshot): string[] | undefined {
  const roots = new Set<string>();
  for (const skill of skillsSnapshot?.resolvedSkills ?? []) {
    const baseDir = typeof skill.baseDir === "string" ? skill.baseDir.trim() : "";
    const filePath = typeof skill.filePath === "string" ? skill.filePath.trim() : "";
    const root = baseDir || (filePath ? path.dirname(filePath) : "");
    if (!root || !path.isAbsolute(root)) {
      continue;
    }
    roots.add(path.resolve(root));
  }
  return roots.size > 0 ? Array.from(roots) : undefined;
}

function guardHostWorkspaceTool(
  tool: AnyAgentTool,
  options: Pick<CoreCodingToolsOptions, "codingRoot" | "containmentRoot">,
): AnyAgentTool {
  return wrapToolWorkspaceRootGuardWithOptions(tool, options.containmentRoot, {
    resolutionCwd: options.codingRoot,
    normalizeGuardedPathParams: true,
  });
}

type CoreCodingToolsOptions = {
  codingRoot: string;
  containmentRoot: string;
  includeBaseCodingTools: boolean;
  shellTools: "disabled" | "patch-only" | "full";
  workspaceOnly: boolean;
  readOnly: boolean;
  sandbox?: SandboxContext;
  skillsSnapshot?: SkillSnapshot;
  skillInstructionPaths?: readonly string[];
  skillInstructionDeliveryCache?: SkillInstructionDeliveryCache;
  modelContextWindowTokens?: number;
  imageSanitization?: ImageSanitizationLimits;
  modelHasVision?: boolean;
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
  baseToolNames?: readonly string[];
  baseToolFactories?: {
    createEditTool: typeof createEditTool;
    createReadTool: typeof CreateReadTool;
    createWriteTool: typeof createWriteTool;
  };
  applyPatchEnabled: boolean;
  applyPatchWorkspaceOnly: boolean;
  execDefaults: ExecToolDefaults;
  processDefaults: ProcessToolDefaults;
  recordToolPrepStage?: (name: string) => void;
};

/** Materialize only the core file and shell families selected by the runtime owner. */
export function createCoreCodingTools(options: CoreCodingToolsOptions): AnyAgentTool[] {
  const sandbox = options.sandbox;
  const sandboxRoot = sandbox?.workspaceDir;
  const sandboxFsBridge = sandbox?.fsBridge;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  if (
    sandboxRoot &&
    !sandboxFsBridge &&
    (options.includeBaseCodingTools || options.includeShellTools)
  ) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }

  const skillReadRoots = sandboxRoot ? undefined : resolveSkillReadRoots(options.skillsSnapshot);
  const needsReadOnlyWorkspaceSkillMounts =
    options.shellTools !== "disabled" || (options.includeBaseCodingTools && options.workspaceOnly);
  const readOnlyWorkspaceSkillMounts =
    sandbox && needsReadOnlyWorkspaceSkillMounts
      ? resolveReadOnlyWorkspaceSkillMounts({
          workspaceDir: sandbox.workspaceDir,
          agentWorkspaceDir: sandbox.agentWorkspaceDir,
          skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
          workdir: sandbox.containerWorkdir,
          workspaceAccess: sandbox.workspaceAccess,
        })
      : [];

  const base: AnyAgentTool[] = [];
  if (options.includeBaseCodingTools) {
    const baseToolNames = new Set(options.baseToolNames ?? ["read", "edit", "write"]);
    if (baseToolNames.has("read")) {
      const read = sandboxRoot
        ? createSandboxedReadTool({
            root: sandboxRoot,
            bridge: sandboxFsBridge!,
            modelContextWindowTokens: options.modelContextWindowTokens,
            imageSanitization: options.imageSanitization,
            modelHasVision: options.modelHasVision,
            createTool: options.baseToolFactories?.createReadTool,
          })
        : (options.baseToolFactories?.createReadTool ?? createReadTool)(options.codingRoot, {
            maxBytes: resolveAdaptiveReadMaxBytes(options),
            modelHasVision: options.modelHasVision,
          });
      const guarded = options.workspaceOnly
        ? wrapToolWorkspaceRootGuardWithOptions(
            read,
            sandboxRoot ?? options.containmentRoot,
            sandboxRoot
              ? {
                  additionalContainerMounts: sandboxReadMounts(sandbox),
                  containerWorkdir: sandbox.containerWorkdir,
                  bridge: sandboxFsBridge,
                }
              : {
                  additionalRoots: skillReadRoots,
                  resolutionCwd: options.codingRoot,
                  normalizeGuardedPathParams: true,
                },
          )
        : read;
      // Relative read semantics (including optional daily journals) run before
      // the guard forwards its checked absolute path to the filesystem reader.
      const wrapped = sandboxRoot
        ? guarded
        : createOpenClawReadTool(guarded, {
            modelContextWindowTokens: options.modelContextWindowTokens,
            imageSanitization: options.imageSanitization,
            cwd: options.codingRoot,
          });
      base.push(
        wrapReadToolWithSkillContent(wrapped, options.skillsSnapshot?.resolvedSkills, {
          modelContextWindowTokens: options.modelContextWindowTokens,
          imageSanitization: options.imageSanitization,
          cwd: options.codingRoot,
          containerWorkdir: sandbox?.containerWorkdir,
          instructionPaths: options.skillInstructionPaths,
          instructionDeliveryCache: options.skillInstructionDeliveryCache,
        }),
      );
    }
    if (!options.readOnly && !sandboxRoot && baseToolNames.has("edit")) {
      const edit = createHostWorkspaceEditTool(options.codingRoot, {
        containmentRoot: options.containmentRoot,
        workspaceOnly: options.workspaceOnly,
        memoryWriteProvenance: options.memoryWriteProvenance,
        createTool: options.baseToolFactories?.createEditTool,
      });
      base.push(options.workspaceOnly ? guardHostWorkspaceTool(edit, options) : edit);
    }
    if (!options.readOnly && !sandboxRoot && baseToolNames.has("write")) {
      const write = createHostWorkspaceWriteTool(options.codingRoot, {
        containmentRoot: options.containmentRoot,
        workspaceOnly: options.workspaceOnly,
        memoryWriteProvenance: options.memoryWriteProvenance,
        createTool: options.baseToolFactories?.createWriteTool,
      });
      base.push(options.workspaceOnly ? guardHostWorkspaceTool(write, options) : write);
    }
  }

  if (options.includeBaseCodingTools && !options.readOnly && sandboxRoot && allowWorkspaceWrites) {
    const toolOptions = {
      root: sandboxRoot,
      bridge: sandboxFsBridge!,
      memoryWriteProvenance: options.memoryWriteProvenance,
    };
    const edit = createSandboxedEditTool({
      ...toolOptions,
      createTool: options.baseToolFactories?.createEditTool,
    });
    const write = createSandboxedWriteTool({
      ...toolOptions,
      createTool: options.baseToolFactories?.createWriteTool,
    });
    base.push(
      options.workspaceOnly
        ? wrapToolWorkspaceRootGuardWithOptions(edit, sandboxRoot, {
            containerWorkdir: sandbox.containerWorkdir,
            bridge: sandboxFsBridge,
          })
        : edit,
      options.workspaceOnly
        ? wrapToolWorkspaceRootGuardWithOptions(write, sandboxRoot, {
            containerWorkdir: sandbox.containerWorkdir,
            bridge: sandboxFsBridge,
          })
        : write,
    );
  }
  options.recordToolPrepStage?.("base-coding-tools");

  const shell: AnyAgentTool[] = [];
  if (
    options.shellTools !== "disabled" &&
    options.applyPatchEnabled &&
    (!sandboxRoot || allowWorkspaceWrites)
  ) {
    shell.push(
      createApplyPatchTool({
        cwd: options.codingRoot,
        root: options.containmentRoot,
        sandbox:
          sandboxRoot && allowWorkspaceWrites
            ? { root: sandboxRoot, bridge: sandboxFsBridge! }
            : undefined,
        workspaceOnly: options.applyPatchWorkspaceOnly,
        memoryWriteProvenance: options.memoryWriteProvenance,
      }),
    );
  }
  if (options.shellTools === "full") {
    shell.push(
      createLazyExecTool({
        ...options.execDefaults,
        ...(sandbox?.required ? { sandboxRequired: true } : {}),
        cwd: options.codingRoot,
        sandbox: sandbox
          ? {
              containerName: sandbox.containerName,
              workspaceDir: sandbox.workspaceDir,
              containerWorkdir: sandbox.containerWorkdir,
              workdirValidation: sandbox.backend?.workdirValidation,
              validateWorkdir: sandbox.backend?.validateWorkdir?.bind(sandbox.backend),
              discardPreparedWorkdir: sandbox.backend?.discardPreparedWorkdir?.bind(
                sandbox.backend,
              ),
              workdirRoots: sandbox.backend?.workdirRoots,
              readOnlyWorkspaceSkillMounts,
              env: sandbox.backend?.env ?? sandbox.docker.env,
              buildExecSpec: sandbox.backend?.buildExecSpec.bind(sandbox.backend),
              finalizeExec: sandbox.backend?.finalizeExec?.bind(sandbox.backend),
            }
          : undefined,
      }),
      createLazyProcessTool(options.processDefaults),
    );
  }
  options.recordToolPrepStage?.("shell-tools");

  base.forEach((tool) =>
    bindAgentToolActionDescriptor(tool, { family: "data", operation: "filesystem" }),
  );
  shell.forEach((tool) =>
    bindAgentToolActionDescriptor(tool, { family: "tool", operation: "process" }),
  );
  return [...base, ...shell];
}
