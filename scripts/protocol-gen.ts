// Protocol Gen script supports OpenClaw repository automation.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolSchemas } from "../packages/gateway-protocol/src/schema/protocol-schemas.js";
import { listCoreGatewayMethodMetadata } from "../src/gateway/methods/core-descriptors.js";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mts";
import {
  assertProtocolSchemaDocument,
  buildProtocolSchemaDocument,
} from "./lib/protocol-schema-document.mts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultOutputPath = path.join(repoRoot, "dist", "protocol.schema.json");

function resolveOutputPath(args: string[]): string {
  let outputPath = defaultOutputPath;
  let hasOutputPath = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--out") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (hasOutputPath) {
      throw new Error("--out may only be specified once.");
    }
    const value = args[index + 1]?.trim();
    if (!value || value === "--out") {
      throw new Error("--out requires a path.");
    }
    outputPath = path.resolve(value);
    hasOutputPath = true;
    index += 1;
  }
  return outputPath;
}

function main() {
  const document = buildProtocolSchemaDocument({
    methods: listCoreGatewayMethodMetadata(),
    schemas: ProtocolSchemas,
  });
  // The artifact is a build output with no committed baseline, so this contract
  // check is the only guard between a degraded registry and the published
  // schema; a regenerate-then-diff guard on it can never fail.
  assertProtocolSchemaDocument(document);
  const result = writeGeneratedOutput({
    check: false,
    next: JSON.stringify(document, null, 2),
    outputPath: resolveOutputPath(process.argv.slice(2)),
    repoRoot,
  });
  const displayPath = path.relative(repoRoot, result.outputPath);
  console.log(
    result.wrote
      ? `[protocol-gen] wrote ${displayPath}`
      : `[protocol-gen] unchanged ${displayPath}`,
  );
}

try {
  main();
} catch (err: unknown) {
  console.error(err);
  process.exit(1);
}
