import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Replicate the exact grep schema change
const schema = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Integer({ description: "Context lines" })),
  limit: Type.Optional(Type.Integer({ description: "Max matches" })),
});

const tests = [
  ["Valid int context+limit (50)", { pattern: "foo", context: 3, limit: 50 }, true],
  ["Float context 1.5 rejected", { pattern: "foo", context: 1.5, limit: 50 }, false],
  ["Float limit 10.5 rejected", { pattern: "foo", context: 3, limit: 10.5 }, false],
  ["Zero context accepted", { pattern: "foo", context: 0, limit: 10 }, true],
  ["Omitted optionals", { pattern: "foo" }, true],
];

let pass = 0,
  fail = 0;
for (const [desc, input, expected] of tests) {
  const result = Value.Check(schema, input);
  const ok = result === expected;
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${desc}: ${result} (expected ${expected})`);
}
console.log(`\n${fail === 0 ? "✅ All passed" : "❌ Some failed"} (${pass}/${pass + fail})`);
process.exit(fail > 0 ? 1 : 0);
