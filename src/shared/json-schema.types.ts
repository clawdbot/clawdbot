import type { TSchema } from "typebox";

export type JsonSchemaObject = TSchema & Record<string, unknown>;
