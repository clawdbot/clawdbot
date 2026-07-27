// Protocol Gen script supports OpenClaw repository automation.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolSchemas } from "../packages/gateway-protocol/src/schema.js";
import { listCoreGatewayMethodMetadata } from "../src/gateway/methods/core-descriptors.js";

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

async function writeJsonSchema(jsonSchemaPath: string) {
  const definitions: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(ProtocolSchemas)) {
    definitions[name] = schema;
  }
  const methods = Object.fromEntries(
    listCoreGatewayMethodMetadata().map(({ name, scope, since }) => [name, { since, scope }]),
  );

  const rootSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://openclaw.ai/protocol.schema.json",
    title: "OpenClaw Gateway Protocol",
    description: "Handshake, request/response, and event frames for the Gateway WebSocket.",
    oneOf: [
      { $ref: "#/definitions/RequestFrame" },
      { $ref: "#/definitions/ResponseFrame" },
      { $ref: "#/definitions/EventFrame" },
    ],
    discriminator: {
      propertyName: "type",
      mapping: {
        req: "#/definitions/RequestFrame",
        res: "#/definitions/ResponseFrame",
        event: "#/definitions/EventFrame",
      },
    },
    methods,
    definitions,
  };

  await fs.mkdir(path.dirname(jsonSchemaPath), { recursive: true });
  await fs.writeFile(jsonSchemaPath, JSON.stringify(rootSchema, null, 2));
  console.log(`wrote ${jsonSchemaPath}`);
  return { jsonSchemaPath, schemaString: JSON.stringify(rootSchema) };
}

async function main() {
  await writeJsonSchema(resolveOutputPath(process.argv.slice(2)));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
