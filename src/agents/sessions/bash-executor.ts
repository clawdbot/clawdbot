/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { sanitizeBinaryOutput } from "../shell-utils.js";
import type { BashOperations } from "./tools/bash-operations.js";
import { OutputAccumulator } from "./tools/output-accumulator.js";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
  /** Callback for streaming output chunks (already sanitized) */
  onChunk?: (chunk: string) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface BashResult {
  /** Combined stdout + stderr output (sanitized, possibly truncated) */
  output: string;
  /** Process exit code (undefined if killed/cancelled) */
  exitCode: number | undefined;
  /** Whether the command was cancelled via signal */
  cancelled: boolean;
  /** Whether the output was truncated */
  truncated: boolean;
  /** Path to temp file containing full output (if output exceeded truncation threshold) */
  fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
  command: string,
  cwd: string,
  operations: BashOperations,
  options?: BashExecutorOptions,
): Promise<BashResult> {
  const output = new OutputAccumulator({
    tempFilePrefix: "openclaw-bash",
    transformDecodedText: (text) =>
      sanitizeBinaryOutput(text, { ansiMode: "compat" }).replace(/\r/g, ""),
  });

  const onData = (data: Buffer) => {
    const text = output.append(data);
    options?.onChunk?.(text);
  };

  const finalizeOutput = async () => {
    const finalText = output.finish();
    const snapshot = output.snapshot({ persistIfTruncated: true });
    try {
      if (finalText) {
        options?.onChunk?.(finalText);
      }
      return snapshot;
    } finally {
      await output.closeTempFile();
    }
  };

  const buildResult = async (
    exitCode: number | undefined,
    cancelled: boolean,
  ): Promise<BashResult> => {
    const snapshot = await finalizeOutput();
    return {
      output: snapshot.content,
      exitCode: cancelled ? undefined : exitCode,
      cancelled,
      truncated: snapshot.truncation.truncated,
      fullOutputPath: snapshot.fullOutputPath,
    };
  };

  let result: Awaited<ReturnType<BashOperations["exec"]>>;
  try {
    result = await operations.exec(command, cwd, {
      onData,
      signal: options?.signal,
    });
  } catch (err) {
    if (options?.signal?.aborted) {
      return await buildResult(undefined, true);
    }
    await finalizeOutput();
    throw err;
  }

  const cancelled = options?.signal?.aborted ?? false;
  return await buildResult(result.exitCode ?? undefined, cancelled);
}
