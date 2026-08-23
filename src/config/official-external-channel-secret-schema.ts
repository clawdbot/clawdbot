/** Widens official external channel schemas for host-resolved SecretRef fields. */
import {
  getOfficialExternalChannelHostSchemaAllOf,
  getOfficialExternalChannelSecretContract,
} from "../plugins/official-external-plugin-catalog.js";
import { cloneSchema } from "./schema.shared.js";
import { SecretRefSchema } from "./zod-schema.core.js";

type JsonSchemaObject = Record<string, unknown> & {
  properties?: Record<string, JsonSchemaObject>;
  additionalProperties?: boolean | JsonSchemaObject;
  anyOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
};

const SECRET_REF_SCHEMA = SecretRefSchema.toJSONSchema({
  io: "input",
  target: "draft-07",
  unrepresentable: "any",
}) as JsonSchemaObject;

function asSchemaObject(value: unknown): JsonSchemaObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchemaObject)
    : undefined;
}

function widenProperties(
  properties: Record<string, JsonSchemaObject> | undefined,
  fields: readonly string[],
): void {
  if (!properties) {
    return;
  }
  for (const field of fields) {
    const current = asSchemaObject(properties[field]);
    if (current) {
      properties[field] = { anyOf: [current, cloneSchema(SECRET_REF_SCHEMA)] };
    }
  }
}

/** Keeps external plugin schemas honest while allowing host-resolved secret inputs. */
export function widenOfficialExternalChannelSecretSchema(params: {
  channelId: string;
  schema: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  const contract = getOfficialExternalChannelSecretContract(params.channelId);
  const hostSchemaAllOf = getOfficialExternalChannelHostSchemaAllOf(params.channelId);
  if ((!contract && hostSchemaAllOf.length === 0) || !params.schema) {
    return params.schema;
  }
  const next = cloneSchema(params.schema) as JsonSchemaObject;
  if (contract) {
    const fields = contract.fields.map((field) => field.field);
    widenProperties(next.properties, fields);
    const accounts = asSchemaObject(next.properties?.accounts);
    const accountSchema = asSchemaObject(accounts?.additionalProperties);
    widenProperties(accountSchema?.properties, fields);
  }
  if (hostSchemaAllOf.length > 0) {
    next.allOf = [
      ...(Array.isArray(next.allOf) ? next.allOf : []),
      ...hostSchemaAllOf.map((clause) => cloneSchema(clause) as JsonSchemaObject),
    ];
  }
  return next;
}
