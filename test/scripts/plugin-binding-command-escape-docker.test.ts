import { Buffer } from "node:buffer";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as stringDecoder from "node:string_decoder";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/e2e/plugin-binding-command-escape-docker.sh";
const script = readFileSync(SCRIPT_PATH, "utf8");
const parserMatch = script.match(
  /if ! node - "\$RUN_LOG" <<'NODE'\n(?<parser>[\s\S]*?)\nNODE\nthen/u,
);

if (!parserMatch?.groups?.parser) {
  throw new Error(`failed to extract embedded log parser from ${SCRIPT_PATH}`);
}

const parser = parserMatch.groups.parser;

class ParserExit extends Error {
  constructor(readonly code: number) {
    super(`parser exited ${code}`);
  }
}

function runParser(log: string, options: { maxReadBytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-plugin-binding-log-proof-"));
  const logPath = join(root, "vitest.log");
  const errors: string[] = [];
  const readSizes: number[] = [];
  writeFileSync(logPath, log);

  const fsProxy = new Proxy(fs, {
    get(target, property, receiver) {
      if (property !== "readSync") {
        return Reflect.get(target, property, receiver);
      }
      return (
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        const boundedLength = Math.min(length, options.maxReadBytes ?? length);
        const bytesRead = fs.readSync(fd, buffer, offset, boundedLength, position);
        readSizes.push(bytesRead);
        return bytesRead;
      };
    },
  });

  try {
    vm.runInNewContext(parser, {
      Buffer,
      console: {
        error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
      },
      process: {
        argv: ["node", "-", logPath],
        exit: (code = 0) => {
          throw new ParserExit(code);
        },
      },
      require: (specifier: string) => {
        if (specifier === "node:fs") {
          return fsProxy;
        }
        if (specifier === "node:string_decoder") {
          return stringDecoder;
        }
        throw new Error(`unexpected parser dependency: ${specifier}`);
      },
    });
    return { errors, readSizes, status: 0 };
  } catch (error) {
    if (error instanceof ParserExit) {
      return { errors, readSizes, status: error.code };
    }
    throw error;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("plugin binding Docker log proof", () => {
  it("runs the aggregate main suite and both files after the suite split", () => {
    expect(script).toContain(
      "if [[ -f src/auto-reply/reply/dispatch-from-config.lifecycle-and-bindings.test.ts ]]",
    );
    expect(script).toContain(
      "src/auto-reply/reply/dispatch-from-config.lifecycle-and-bindings.test.ts",
    );
    expect(script).toContain("src/auto-reply/reply/dispatch-from-config.test.ts");
    expect(script).toContain('node scripts/run-vitest.mjs "${test_files[@]}"');
  });

  it("aggregates split summaries across the complete log with bounded partial reads", () => {
    const noise = "not a summary\n".repeat(6000);
    const log = [
      "\u001B[32m Tests  2 passed\u001B[39m\n",
      `${noise}\u{1F98A}${noise}`,
      "\u001B[32m Tests  1 passed\u001B[39m\n",
    ].join("");

    const result = runParser(log, { maxReadBytes: 3 });

    expect(Buffer.byteLength(noise)).toBeGreaterThan(65536);
    expect(result.status).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.readSizes.length).toBeGreaterThan(2);
    expect(result.readSizes.every((size) => size <= 3)).toBe(true);
  });

  it("accepts one aggregate summary", () => {
    expect(runParser(" Tests  3 passed | 4 skipped (7)\n").status).toBe(0);
  });

  it("rejects split summaries with the wrong total", () => {
    const result = runParser(" Tests  1 passed\n Tests  1 passed\n");

    expect(result.status).toBe(1);
    expect(result.errors.join("\n")).toContain("2 summaries totaling 2");
  });

  it("rejects extra summaries even when their total is three", () => {
    const result = runParser(" Tests  1 passed\n Tests  1 passed\n Tests  1 passed\n");

    expect(result.status).toBe(1);
    expect(result.errors.join("\n")).toContain("3 summaries");
  });
});
