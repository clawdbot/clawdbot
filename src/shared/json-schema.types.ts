import type { TSchema } from "typebox";

/** TypeBox schema value widened for generic JSON-schema object transforms. */
export type JsonSchemaObject = TSchema & Record<string, unknown>;
