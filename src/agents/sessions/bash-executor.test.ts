// Bash executor tests cover bounded UTF-8 output and private sanitized spills.
import { readFile, rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "./bash-executor.js";
import type { BashOperations } from "./tools/bash-operations.js";
import { DEFAULT_MAX_BYTES } from "./tools/truncate.js";

describe("executeBashWithOperations", () => {
  it("stores truncated full output in an owner-only temp file", async () => {
    const sanitizedOutput = "secret output\n".repeat(9000);
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("\u001b[31msecret output\u001b[0m\n".repeat(9000)));
        return { exitCode: 0 };
      },
    };

    const result = await executeBashWithOperations("echo secret", "/tmp", operations);

    expect(result.truncated).toBe(true);
    expect(result.fullOutputPath).toBeDefined();
    // Full output can include secrets printed by a command, so the spill file
    // must be unreadable by group/other accounts.
    const mode = (await stat(result.fullOutputPath!)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
    expect(await readFile(result.fullOutputPath!, "utf8")).toBe(sanitizedOutput);
    await rm(result.fullOutputPath!, { force: true });
  });

  it("preserves the exact UTF-8 tail across output chunk boundaries", async () => {
    const asciiChunk = "a".repeat(80 * 1024);
    const multibyteChunk = "界".repeat(10 * 1024);
    const expectedAsciiBytes = DEFAULT_MAX_BYTES - Buffer.byteLength(multibyteChunk, "utf8");
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from(asciiChunk));
        options.onData(Buffer.from(multibyteChunk));
        return { exitCode: 0 };
      },
    };

    const result = await executeBashWithOperations("printf output", "/tmp", operations);

    expect(result.truncated).toBe(true);
    expect(result.fullOutputPath).toBeDefined();
    expect(Buffer.byteLength(result.output, "utf8")).toBe(DEFAULT_MAX_BYTES);
    expect(result.output).toBe("a".repeat(expectedAsciiBytes) + multibyteChunk);
    await rm(result.fullOutputPath!, { force: true });
  });

  it("sanitizes ANSI and OSC sequences split across output chunks", async () => {
    const chunks: string[] = [];
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        for (const chunk of [
          "A\u001B]0;title",
          "\u0007B",
          "C\u001B[31",
          "mD",
          "E\u009D0;title",
          "\u001B\\F",
          "G\u009B31",
          "mH",
        ]) {
          options.onData(Buffer.from(chunk));
        }
        return { exitCode: 0 };
      },
    };

    const result = await executeBashWithOperations("printf styled", "/tmp", operations, {
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join("")).toBe("ABCDEFGH");
    expect(result.output).toBe("ABCDEFGH");
  });

  it("stores sanitized split ANSI output in spilled full output files", async () => {
    const chunks = ["A\u001B]0;title", "\u0007B\n"];
    const repeatedChunks = Array.from({ length: 9000 }, (_, index) => chunks[index % 2] ?? "");
    const expectedOutput = "AB\n".repeat(4500);
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        for (const chunk of repeatedChunks) {
          options.onData(Buffer.from(chunk));
        }
        return { exitCode: 0 };
      },
    };

    const result = await executeBashWithOperations("printf styled", "/tmp", operations);

    expect(result.truncated).toBe(true);
    expect(result.fullOutputPath).toBeDefined();
    expect(await readFile(result.fullOutputPath!, "utf8")).toBe(expectedOutput);
    await rm(result.fullOutputPath!, { force: true });
  });

  it("sanitizes split compatibility escape grammar sequences", async () => {
    const chunks: string[] = [];
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("A\u001B("));
        options.onData(Buffer.from("BB"));
        return { exitCode: 0 };
      },
    };

    const result = await executeBashWithOperations("printf styled", "/tmp", operations, {
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join("")).toBe("AB");
    expect(result.output).toBe("AB");
  });

  it("does not retain unterminated OSC payload outside accumulator limits", async () => {
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("safe\n\u001B]0;"));
        options.onData(Buffer.from("x".repeat(DEFAULT_MAX_BYTES * 3)));
        return { exitCode: 0 };
      },
    };

    const result = await executeBashWithOperations("printf styled", "/tmp", operations);

    expect(result.output).toBe("safe\n");
    expect(result.truncated).toBe(false);
    expect(result.fullOutputPath).toBeDefined();
    expect(await readFile(result.fullOutputPath!, "utf8")).toBe("safe\n");
    await rm(result.fullOutputPath!, { force: true });
  });

  it.each([
    { name: "success", abort: false },
    { name: "abort", abort: true },
  ])("flushes incomplete UTF-8 output on $name", async ({ abort }) => {
    const abortController = new AbortController();
    const chunks: string[] = [];
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from([0xf0, 0x9f, 0x98]));
        if (abort) {
          abortController.abort();
          throw new Error("aborted");
        }
        return { exitCode: 0 };
      },
    };

    const result = await executeBashWithOperations("printf output", "/tmp", operations, {
      signal: abortController.signal,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.output).toBe("�");
    expect(chunks.join("")).toBe("�");
    expect(result.cancelled).toBe(abort);
    expect(result.exitCode).toBe(abort ? undefined : 0);
  });
});
