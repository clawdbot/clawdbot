import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createReadToolDefinition } from "./read.js";

const mode = process.argv[2];
assert.ok(mode === "line" || mode === "range" || mode === "cursor");
const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const inputUnits = 2 * 1024 * 1024;
let readIndex = 0;

function line(index: number) {
  return `${String.fromCharCode(65 + index).repeat(1020)}\ud800x🦞\udc00`;
}

const tool = createReadToolDefinition(process.cwd(), {
  operations: {
    access: async () => {},
    detectImageMimeType: async () => null,
    decodeText: ({ buffer }) => buffer.toString("utf16le"),
    readFile: async () => {
      const index = readIndex++ % 8;
      const bytes = Buffer.alloc(inputUnits * 2);
      bytes.fill(Buffer.from([65 + index, 0]));
      bytes.write(`${line(index)}\n${line(index)}\n${line(index)}\n`, 0, "utf16le");
      return bytes;
    },
  },
});

async function makeResults() {
  const results = [];
  for (let index = 0; index < 8; index++) {
    results.push(
      await tool.execute(
        `read-${index}`,
        {
          path: "synthetic-large.txt",
          offset: mode === "range" ? 2 : 1,
          limit: mode === "range" ? 2 : 1,
          ...(mode === "cursor" ? { cursor: 10 } : {}),
        },
        undefined,
        undefined,
        {} as never,
      ),
    );
  }
  return results;
}

async function collect() {
  for (let pass = 0; pass < 3; pass++) {
    await setImmediate();
    gc!();
  }
  return process.memoryUsage();
}

// Warm the reader before measuring retained results, not import/initialization work.
await makeResults();
const before = await collect();
const results = await makeResults();
const held = await collect();
// Inspect only after GC: string assertions/serialization can flatten slices and hide retention.
for (const [index, result] of results.entries()) {
  const expected: string =
    mode === "range"
      ? `${line(index)}\n${line(index)}`
      : line(index).slice(mode === "cursor" ? 10 : 0);
  assert.equal(result.details?.kind, "truncated");
  assert.equal(result.details?.content, expected);
  assert.deepEqual(result.details?.continuation, {
    kind: "line",
    offset: mode === "range" ? 4 : 2,
    limit: mode === "range" ? 2 : 1,
  });
  assert.equal(result.content[0]?.type, "text");
  assert.ok(result.content[0]?.type === "text" && result.content[0].text.startsWith(expected));
}
process.stdout.write(
  JSON.stringify({
    mode,
    resultCount: results.length,
    heapUsedIncrease: held.heapUsed - before.heapUsed,
    externalIncrease: held.external - before.external,
  }),
);
