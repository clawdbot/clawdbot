/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import type { WriteStream } from "node:fs";
import { stripAnsi } from "../utils/ansi.js";
import { sanitizeBinaryOutput } from "../utils/shell.js";
import type { BashOperations } from "./tools/bash-operations.js";
import { createPrivateTempWriteStream } from "./tools/private-temp-file.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";

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
  const outputChunks: string[] = [];
  let outputBytes = 0;
  const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

  let tempFilePath: string | undefined;
  let tempFileStream: WriteStream | undefined;
  let totalBytes = 0;

  const ensureTempFile = () => {
    if (tempFilePath) {
      return;
    }
    const tempFile = createPrivateTempWriteStream("openclaw-bash");
    tempFilePath = tempFile.path;
    tempFileStream = tempFile.stream;
    for (const chunk of outputChunks) {
      tempFileStream.write(chunk);
    }
  };

  const closeTempFile = async () => {
    if (!tempFileStream) {
      return;
    }
    const stream = tempFileStream;
    tempFileStream = undefined;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  };

  const decoder = new TextDecoder();

  const onData = (data: Buffer) => {
    totalBytes += data.length;

    // Sanitize: strip ANSI, replace binary garbage, normalize newlines
    const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(
      /\r/g,
      "",
    );

    // Start writing to temp file if exceeds threshold
    if (totalBytes > DEFAULT_MAX_BYTES) {
      ensureTempFile();
    }

    if (tempFileStream) {
      tempFileStream.write(text);
    }

    // Keep rolling buffer
    outputChunks.push(text);
    outputBytes += text.length;
    while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
      const removed = outputChunks.shift()!;
      outputBytes -= removed.length;
    }

    // Stream to callback
    if (options?.onChunk) {
      options.onChunk(text);
    }
  };

  try {
    const result = await operations.exec(command, cwd, {
      onData,
      signal: options?.signal,
    });

    const fullOutput = outputChunks.join("");
    const truncationResult = truncateTail(fullOutput);
    if (truncationResult.truncated) {
      ensureTempFile();
    }
    await closeTempFile();
    const cancelled = options?.signal?.aborted ?? false;

    return {
      output: truncationResult.truncated ? truncationResult.content : fullOutput,
      exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
      cancelled,
      truncated: truncationResult.truncated,
      fullOutputPath: tempFilePath,
    };
  } catch (err) {
    // Check if it was an abort
    if (options?.signal?.aborted) {
      const fullOutput = outputChunks.join("");
      const truncationResult = truncateTail(fullOutput);
      if (truncationResult.truncated) {
        ensureTempFile();
      }
      await closeTempFile();
      return {
        output: truncationResult.truncated ? truncationResult.content : fullOutput,
        exitCode: undefined,
        cancelled: true,
        truncated: truncationResult.truncated,
        fullOutputPath: tempFilePath,
      };
    }

    await closeTempFile();

    throw err;
  }
}
