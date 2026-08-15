import { Type, type TProperties } from "typebox";

export function closedObject<Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}
