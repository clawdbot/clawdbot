/**
 * Built-in bash session tool.
 *
 * Executes local shell commands with streaming output accumulation and TUI renderers.
 */
import { existsSync } from "node:fs";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { Type } from "typebox";
import { toErrorObject } from "../../../infra/errors.js";
import { formatDurationSeconds } from "../../../infra/format-time/format-duration.js";
import { releaseChildProcessOutputAfterExit } from "../../../process/child-process.js";
import { spawnCommand } from "../../../process/exec.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.js";
import { theme } from "../../modes/interactive/theme/theme.js";
import type { AgentTool } from "../../runtime/index.js";
import { getBashShellConfig, getShellEnv, killProcessTree } from "../../shell-utils.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import type { BashOperations } from "./bash-operations.js";
import { OutputAccumulator } from "./output-accumulator.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { formatFullOutputFooter, type BashToolDetails } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.js";

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command." }),
  timeout: Type.Optional(Type.Number({ description: "Optional timeout seconds; default none." })),
});
export function resolveBashTimeoutMs(timeoutSeconds: unknown): number | undefined {
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    return undefined;
  }
  return resolveTimerTimeoutMs(timeoutSeconds * 1000, 1);
}

/**
 * Create bash operations using OpenClaw runtime's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want OpenClaw runtime's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout, env }) => {
      return new Promise((resolve, reject) => {
        const { shell, args } = getBashShellConfig(options?.shellPath);
        if (!existsSync(cwd)) {
          reject(
            new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`),
          );
          return;
        }
        const child = spawnCommand([shell, ...args, command], {
          baseEnv: {},
          buffer: false,
          cwd,
          detached: process.platform !== "win32",
          env: env ?? getShellEnv(),
          reject: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const releaseOutput = releaseChildProcessOutputAfterExit(child);
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutMs = resolveBashTimeoutMs(timeout);
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              killProcessTree(child.pid);
            }
          }, timeoutMs);
        }
        // Stream stdout and stderr.
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        // Handle abort signal by killing the entire process tree.
        const onAbort = () => {
          if (child.pid) {
            killProcessTree(child.pid);
          }
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
        void child
          .then((result) => {
            if (result.failed && result.exitCode === undefined && result.signal === undefined) {
              if (result instanceof Error) {
                throw result;
              }
              throw new Error(`Failed to launch shell: ${shell}`, { cause: result });
            }
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            if (timedOut) {
              reject(new Error(`timeout:${timeout}`));
              return;
            }
            resolve({ exitCode: result.exitCode ?? (result.failed ? 1 : 0) });
          })
          .catch((err: unknown) => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }
            reject(toErrorObject(err, "Non-Error rejection"));
          })
          .finally(releaseOutput);
      });
    },
  };
}

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
  command: string,
  cwd: string,
  spawnHook?: BashSpawnHook,
): BashSpawnContext {
  const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
  return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
  /** Custom operations for command execution. Default: local shell */
  operations?: BashOperations;
  /** Command prefix prepended to every command (for example shell setup commands) */
  commandPrefix?: string;
  /** Optional explicit shell path from settings */
  shellPath?: string;
  /** Hook to adjust command, cwd, or env before execution */
  spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
  cachedWidth: number | undefined;
  cachedLines: string[] | undefined;
  cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
  state: BashResultRenderState = {
    cachedWidth: undefined,
    cachedLines: undefined,
    cachedSkipped: undefined,
  };
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
  const command = str(args?.command);
  const timeout = args?.timeout;
  const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
  const commandDisplay =
    command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
  return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
  component: BashResultRenderComponent,
  result: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: BashToolDetails;
  },
  options: ToolRenderResultOptions,
  showImages: boolean,
  startedAt: number | undefined,
  endedAt: number | undefined,
): void {
  const state = component.state;
  component.clear();

  let output = getTextOutput(result, showImages).trim();
  const truncation = result.details?.truncation;
  const fullOutputPath = result.details?.fullOutputPath;
  if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
      output = output.slice(0, footerStart).trimEnd();
    }
  }

  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded) {
      component.addChild(new Text(`\n${styledOutput}`, 0, 0));
    } else {
      component.addChild({
        render: (width: number) => {
          if (state.cachedLines === undefined || state.cachedWidth !== width) {
            const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
            state.cachedLines = preview.visualLines;
            state.cachedSkipped = preview.skippedCount;
            state.cachedWidth = width;
          }
          if (state.cachedSkipped && state.cachedSkipped > 0) {
            const hint =
              theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")})`;
            return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
          }
          return ["", ...(state.cachedLines ?? [])];
        },
        invalidate: () => {
          state.cachedWidth = undefined;
          state.cachedLines = undefined;
          state.cachedSkipped = undefined;
        },
      });
    }
  }

  if (truncation?.truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) {
      warnings.push(formatFullOutputFooter(fullOutputPath));
    }
    if (truncation?.truncated) {
      if (truncation.truncatedBy === "lines") {
        warnings.push(
          `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
        );
      } else {
        warnings.push(
          `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
        );
      }
    }
    component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
  }

  if (startedAt !== undefined) {
    const label = options.isPartial ? "Elapsed" : "Took";
    const endTime = endedAt ?? Date.now();
    component.addChild(
      new Text(
        `\n${theme.fg("muted", `${label} ${formatDurationSeconds(endTime - startedAt)}`)}`,
        0,
        0,
      ),
    );
  }
}

export function createBashToolDefinition(
  cwd: string,
  options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
  const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
  const commandPrefix = options?.commandPrefix;
  const spawnHook = options?.spawnHook;
  return {
    name: "bash",
    label: "bash",
    description: `Run bash in cwd; stdout+stderr. Returns last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; full truncated output saved temp. Optional timeout seconds.`,
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    parameters: bashSchema,
    async execute(
      toolCallId,
      { command, timeout }: { command: string; timeout?: number },
      signal?: AbortSignal,
      onUpdate?,
      ctx?,
    ) {
      void toolCallId;
      void ctx;
      const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
      const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
      const output = new OutputAccumulator({ tempFilePrefix: "openclaw-bash" });
      let acceptingOutput = true;
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty) {
          return;
        }
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: [{ type: "text", text: snapshot.content || "" }],
          details: {
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            fullOutputPath: snapshot.fullOutputPath,
          },
        });
      };

      const clearUpdateTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
      };

      const scheduleOutputUpdate = () => {
        if (!onUpdate) {
          return;
        }
        updateDirty = true;
        const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };

      if (onUpdate) {
        onUpdate({ content: [], details: undefined });
      }

      const handleData = (data: Buffer) => {
        if (!acceptingOutput) {
          return;
        }
        output.append(data);
        scheduleOutputUpdate();
      };

      const finishOutput = async () => {
        acceptingOutput = false;
        output.finish();
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        await output.closeTempFile();
        return snapshot;
      };

      const formatOutput = (
        snapshot: Awaited<ReturnType<typeof finishOutput>>,
        emptyText = "(no output)",
      ) => {
        const truncation = snapshot.truncation;
        let text = snapshot.content || emptyText;
        let details: BashToolDetails | undefined;
        if (truncation.truncated) {
          const fullOutputPath = snapshot.fullOutputPath;
          if (!fullOutputPath) {
            throw new Error("Missing full output path for truncated bash output");
          }
          details = { truncation, fullOutputPath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). ${formatFullOutputFooter(fullOutputPath)}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. ${formatFullOutputFooter(fullOutputPath)}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). ${formatFullOutputFooter(fullOutputPath)}]`;
          }
        }
        return { text, details };
      };

      const appendStatus = (text: string, status: string) =>
        `${text ? `${text}\n\n` : ""}${status}`;

      try {
        let exitCode: number | null;
        try {
          const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
            onData: handleData,
            signal,
            timeout,
            env: spawnContext.env,
          });
          exitCode = result.exitCode;
        } catch (err) {
          const snapshot = await finishOutput();
          const { text } = formatOutput(snapshot, "");
          if (err instanceof Error && err.message === "aborted") {
            throw new Error(appendStatus(text, "Command aborted"), { cause: err });
          }
          if (err instanceof Error && err.message.startsWith("timeout:")) {
            const timeoutSecs = err.message.split(":")[1];
            throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`), {
              cause: err,
            });
          }
          throw err;
        }

        const snapshot = await finishOutput();
        const { text: outputText, details } = formatOutput(snapshot);
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
        }
        return { content: [{ type: "text", text: outputText }], details };
      } finally {
        clearUpdateTimer();
      }
    },
    renderCall(args, themeValue, context) {
      void themeValue;
      const state = context.state;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatBashCall(args));
      return text;
    },
    renderResult(result, optionsLocal, themeLocal, context) {
      void themeLocal;
      const state = context.state;
      if (state.startedAt !== undefined && optionsLocal.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!optionsLocal.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }
      const component =
        (context.lastComponent as BashResultRenderComponent | undefined) ??
        new BashResultRenderComponent();
      rebuildBashResultRenderComponent(
        component,
        result,
        optionsLocal,
        context.showImages,
        state.startedAt,
        state.endedAt,
      );
      component.invalidate();
      return component;
    },
  };
}

export function createBashTool(
  cwd: string,
  options?: BashToolOptions,
): AgentTool<typeof bashSchema> {
  return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
