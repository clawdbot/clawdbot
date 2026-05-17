import fs from "node:fs";
import { expect, vi } from "vitest";
import { spawnNodeEvalSync } from "./node-process.js";

type FsScanCounter = "existsSync" | "readdirSync" | "statSync";

type NodeFsScanResult<T> = {
  counts: Partial<Record<FsScanCounter, number>>;
  result: T;
};

export function expectNoReaddirSyncDuring<T>(run: () => T): T {
  return expectNoFsSyncDuring(run, ["readdirSync"]);
}

export function expectNoFsSyncDuring<T>(run: () => T, counters: FsScanCounter[]): T {
  const spies = counters.map((counter) => {
    switch (counter) {
      case "existsSync":
        return vi.spyOn(fs, "existsSync");
      case "readdirSync":
        return vi.spyOn(fs, "readdirSync");
      case "statSync":
        return vi.spyOn(fs, "statSync");
      default: {
        counter satisfies never;
        throw new Error("Unsupported fs scan counter");
      }
    }
  });
  try {
    const result = run();
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
    return result;
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

export function captureReaddirSyncCallsDuring<T>(run: () => T): {
  calls: unknown[][];
  result: T;
} {
  const readDir = vi.spyOn(fs, "readdirSync");
  try {
    const before = readDir.mock.calls.length;
    const result = run();
    return { calls: readDir.mock.calls.slice(before), result };
  } finally {
    readDir.mockRestore();
  }
}

export function expectNoNodeFsScans<T>(
  body: string,
  options?: {
    counters?: FsScanCounter[];
    parseResult?: (result: unknown) => T;
  },
): T {
  const counters = options?.counters ?? ["existsSync", "readdirSync"];
  const result = spawnNodeEvalSync(
    `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const counts = ${JSON.stringify(Object.fromEntries(counters.map((name) => [name, 0])))};
        ${counters
          .map(
            (name) => `
        const ${name}Original = fs.${name};
        fs.${name} = (...args) => {
          counts.${name} += 1;
          return ${name}Original(...args);
        };`,
          )
          .join("\n")}
        syncBuiltinESMExports();
        const result = await (async () => {
          ${body}
        })();
        console.log(JSON.stringify({ counts, result }));
      `,
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout) as NodeFsScanResult<unknown>;
  expect(payload.counts).toEqual(Object.fromEntries(counters.map((name) => [name, 0])));
  return options?.parseResult ? options.parseResult(payload.result) : (payload.result as T);
}
