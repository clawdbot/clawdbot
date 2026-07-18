// Protocol Gen Kotlin script supports OpenClaw repository automation.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_NODE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  ProtocolSchemas,
} from "../packages/gateway-protocol/src/schema.js";
import { listCoreGatewayMethodNames } from "../src/gateway/methods/core-descriptors.js";
import { extractGatewayEventNames } from "./check-protocol-event-coverage.mjs";

type JsonSchema = {
  type?: string | string[];
  const?: boolean | number | string | null;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<boolean | number | string | null>;
  patternProperties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

type EnumSpec = {
  name: string;
  values: Array<{ name: string; rawValue: string }>;
  namespacePrefix?: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const gatewayOutputPath = path.join(
  repoRoot,
  "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewayProtocol.kt",
);
const constantsOutputPath = path.join(
  repoRoot,
  "apps/android/app/src/main/java/ai/openclaw/app/protocol/OpenClawProtocolConstants.kt",
);
const protocolSchemas = ProtocolSchemas as unknown as Record<string, JsonSchema>;

const schemaNames = new Map<string, string>([
  ["ErrorShape", "GatewayProtocolError"],
  ["RequestFrame", "GatewayRequestFrame"],
  ["ResponseFrame", "GatewayResponseFrame"],
  ["EventFrame", "GatewayEventFrame"],
  ["NodeEventParams", "GatewayNodeEventParams"],
  ["NodeInvokeResultParams", "GatewayNodeInvokeResultParams"],
  ["NodeInvokeRequestEvent", "GatewayNodeInvokeRequest"],
  ["QuestionOption", "QuestionOption"],
  ["Question", "Question"],
  ["QuestionAnswers", "QuestionAnswers"],
  ["QuestionRecord", "QuestionRecord"],
  ["QuestionListResult", "QuestionListResult"],
]);

const androidEnums: EnumSpec[] = [
  enumSpec("OpenClawCapability", "", [
    ["Canvas", "canvas"],
    ["Camera", "camera"],
    ["Sms", "sms"],
    ["Talk", "talk"],
    ["Location", "location"],
    ["Device", "device"],
    ["Notifications", "notifications"],
    ["System", "system"],
    ["Photos", "photos"],
    ["Contacts", "contacts"],
    ["Calendar", "calendar"],
    ["Motion", "motion"],
    ["CallLog", "callLog"],
    ["VoiceWake", "voiceWake"],
  ]),
  enumSpec("OpenClawCanvasCommand", "canvas.", [
    ["Present", "present"],
    ["Hide", "hide"],
    ["Navigate", "navigate"],
    ["Eval", "eval"],
    ["Snapshot", "snapshot"],
  ]),
  enumSpec("OpenClawCanvasA2UICommand", "canvas.a2ui.", [
    ["Push", "push"],
    ["PushJSONL", "pushJSONL"],
    ["Reset", "reset"],
  ]),
  enumSpec("OpenClawCameraCommand", "camera.", [
    ["List", "list"],
    ["Snap", "snap"],
    ["Clip", "clip"],
  ]),
  enumSpec("OpenClawSmsCommand", "sms.", [
    ["Send", "send"],
    ["Search", "search"],
  ]),
  enumSpec("OpenClawTalkCommand", "talk.", [
    ["PttStart", "ptt.start"],
    ["PttStop", "ptt.stop"],
    ["PttCancel", "ptt.cancel"],
    ["PttOnce", "ptt.once"],
  ]),
  enumSpec("OpenClawLocationCommand", "location.", [["Get", "get"]]),
  enumSpec("OpenClawDeviceCommand", "device.", [
    ["Status", "status"],
    ["Info", "info"],
    ["Permissions", "permissions"],
    ["Health", "health"],
    ["Apps", "apps"],
  ]),
  enumSpec("OpenClawNotificationsCommand", "notifications.", [
    ["List", "list"],
    ["Actions", "actions"],
  ]),
  enumSpec("OpenClawSystemCommand", "system.", [["Notify", "notify"]]),
  enumSpec("OpenClawPhotosCommand", "photos.", [["Latest", "latest"]]),
  enumSpec("OpenClawContactsCommand", "contacts.", [
    ["Search", "search"],
    ["Add", "add"],
  ]),
  enumSpec("OpenClawCalendarCommand", "calendar.", [
    ["Events", "events"],
    ["Add", "add"],
  ]),
  enumSpec("OpenClawMotionCommand", "motion.", [
    ["Activity", "activity"],
    ["Pedometer", "pedometer"],
  ]),
  enumSpec("OpenClawCallLogCommand", "callLog.", [["Search", "search"]]),
];

function enumSpec(
  name: string,
  namespacePrefix: string,
  values: Array<[name: string, suffix: string]>,
): EnumSpec {
  return {
    name,
    namespacePrefix,
    values: values.map(([caseName, suffix]) => ({
      name: caseName,
      rawValue: namespacePrefix + suffix,
    })),
  };
}

function words(value: string): string[] {
  return (
    value.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g)?.map((part) => part.toLowerCase()) ??
    []
  );
}

function upperCamel(value: string): string {
  const parts = words(value);
  if (parts.length === 0) {
    throw new Error(`Cannot create Kotlin identifier from ${JSON.stringify(value)}`);
  }
  return parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
}

function lowerCamel(value: string): string {
  const name = upperCamel(value);
  return name[0]!.toLowerCase() + name.slice(1);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, stableJson(record[key])]),
    );
  }
  return value;
}

function schemaSignature(schema: JsonSchema): string {
  return JSON.stringify(stableJson(schema));
}

function literalValue(schema: JsonSchema): boolean | number | string | null | undefined {
  if ("const" in schema) {
    return schema.const;
  }
  return schema.enum?.length === 1 ? schema.enum[0] : undefined;
}

function kotlinLiteral(value: boolean | number | string | null): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  return String(value);
}

function emitEnum(spec: EnumSpec): string {
  const body = spec.values.map((value) => `  ${value.name}(${JSON.stringify(value.rawValue)}),`);
  if (spec.namespacePrefix) {
    body.push(
      "  ;",
      "",
      "  companion object {",
      `    const val NamespacePrefix: String = ${JSON.stringify(spec.namespacePrefix)}`,
      "  }",
    );
  }
  return [`enum class ${spec.name}(`, "  val rawValue: String,", ") {", ...body, "}"].join("\n");
}

function emitWireModels(): string[] {
  const selectedSchemas = new Map<JsonSchema, string>();
  const selectedSignatures = new Map<string, string>();
  for (const [schemaName, kotlinName] of schemaNames) {
    const schema = protocolSchemas[schemaName];
    if (!schema) {
      throw new Error(`Missing ProtocolSchemas.${schemaName}`);
    }
    selectedSchemas.set(schema, kotlinName);
    selectedSignatures.set(schemaSignature(schema), kotlinName);
  }

  const nestedModels = new Map<string, JsonSchema>();
  const kotlinType = (schema: JsonSchema, nestedName: string): string => {
    const selected = selectedSchemas.get(schema) ?? selectedSignatures.get(schemaSignature(schema));
    if (selected) {
      return selected;
    }
    const stringUnion = schema.anyOf?.map(literalValue);
    if (stringUnion?.length && stringUnion.every((value) => typeof value === "string")) {
      return "String";
    }
    if (schema.type === "string" || typeof schema.const === "string") {
      return "String";
    }
    if (schema.type === "integer") {
      return "Long";
    }
    if (schema.type === "number") {
      return "Double";
    }
    if (schema.type === "boolean") {
      return "Boolean";
    }
    if (schema.type === "array") {
      return `List<${kotlinType(schema.items ?? {}, `${nestedName}Item`)}>`;
    }
    if (schema.patternProperties) {
      const valueSchema = Object.values(schema.patternProperties)[0] ?? {};
      return `Map<String, ${kotlinType(valueSchema, `${nestedName}Value`)}>`;
    }
    if (schema.type === "object") {
      nestedModels.set(nestedName, schema);
      return nestedName;
    }
    return "JsonElement";
  };

  const emitModel = (name: string, schema: JsonSchema): string => {
    if (schema.type !== "object" || !schema.properties) {
      throw new Error(`${name} must remain an object schema for Kotlin generation`);
    }
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties).map(([wireName, propertySchema]) => {
      const propertyName = lowerCamel(wireName);
      const type = kotlinType(propertySchema, `${name}${upperCamel(wireName)}`);
      const literal = literalValue(propertySchema);
      const optional = !required.has(wireName);
      return {
        annotation: propertyName === wireName ? [] : [`  @SerialName(${JSON.stringify(wireName)})`],
        declaration: `  val ${propertyName}: ${type}${optional ? "?" : ""}${
          literal !== undefined ? ` = ${kotlinLiteral(literal)}` : optional ? " = null" : ""
        },`,
      };
    });
    const fields: string[] = [];
    for (const property of properties) {
      fields.push(...property.annotation, property.declaration);
    }
    return ["@Serializable", `data class ${name}(`, ...fields, ")"].join("\n");
  };

  const output: string[] = [];
  for (const [schemaName, kotlinName] of schemaNames) {
    output.push(emitModel(kotlinName, protocolSchemas[schemaName]!));
  }
  for (const [nestedName, schema] of nestedModels) {
    if (!output.some((model) => model.startsWith(`@Serializable\ndata class ${nestedName}(`))) {
      output.push(emitModel(nestedName, schema));
    }
  }
  return output;
}

function emitGatewayCatalogEnum(name: string, values: readonly string[]): string {
  const seenNames = new Map<string, string>();
  const entries = values.map((rawValue) => {
    const caseName = upperCamel(rawValue);
    const previous = seenNames.get(caseName);
    if (previous) {
      throw new Error(
        `${name} case collision: ${previous} and ${rawValue} both map to ${caseName}`,
      );
    }
    seenNames.set(caseName, rawValue);
    return { name: caseName, rawValue };
  });
  return emitEnum({ name, values: entries });
}

async function generate(): Promise<void> {
  const gatewayEventSource = await fs.readFile(
    path.join(repoRoot, "src/gateway/server-methods-list.ts"),
    "utf8",
  );
  const gatewayEventConstants = await fs.readFile(
    path.join(repoRoot, "src/gateway/events.ts"),
    "utf8",
  );
  const gatewayEvents = Array.from(
    extractGatewayEventNames(gatewayEventSource, gatewayEventConstants),
  );
  const gatewayMethods = listCoreGatewayMethodNames();

  const gatewayContent = [
    "// Generated by scripts/protocol-gen-kotlin.ts — do not edit by hand.",
    "package ai.openclaw.app.gateway",
    "",
    "import kotlinx.serialization.SerialName",
    "import kotlinx.serialization.Serializable",
    "import kotlinx.serialization.json.JsonElement",
    "",
    `const val GATEWAY_PROTOCOL_VERSION = ${PROTOCOL_VERSION}`,
    // Android consumes v3 message-only chat deltas and uses the N-1 node transport.
    `const val GATEWAY_MIN_PROTOCOL_VERSION = ${MIN_NODE_PROTOCOL_VERSION}`,
    "",
    ...emitWireModels().flatMap((model) => [model, ""]),
    emitGatewayCatalogEnum("GatewayMethod", gatewayMethods),
    "",
    emitGatewayCatalogEnum("GatewayEvent", gatewayEvents),
    "",
  ].join("\n");
  const constantsContent = [
    "// Generated by scripts/protocol-gen-kotlin.ts — do not edit by hand.",
    "package ai.openclaw.app.protocol",
    "",
    ...androidEnums.flatMap((spec) => [emitEnum(spec), ""]),
  ].join("\n");

  await fs.writeFile(gatewayOutputPath, gatewayContent);
  await fs.writeFile(constantsOutputPath, constantsContent);
  console.log(`wrote ${path.relative(repoRoot, gatewayOutputPath)}`);
  console.log(`wrote ${path.relative(repoRoot, constantsOutputPath)}`);
}

generate().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
