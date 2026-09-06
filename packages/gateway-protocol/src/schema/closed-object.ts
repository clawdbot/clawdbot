import { Type, type TProperties } from "typebox";

const identityKey = "~openclawClosedObjectIdentity";

export function closedObject<Properties extends TProperties>(properties: Properties) {
  const schema = Type.Object(properties, { additionalProperties: false });
  // TypeBox preserves hidden string-keyed properties when cloning optional schemas.
  // A symbol value keeps nominal identity out of JSON and distinguishes equal shapes.
  Object.defineProperty(schema, identityKey, { value: Symbol("closedObject") });
  return schema;
}
