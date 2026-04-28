/** Root OpenClaw configuration Zod schema — the full `openclaw.json` shape. */
export { OpenClawSchema } from "../config/zod-schema.js";
export { validateJsonSchemaValue } from "../plugins/schema-validator.js";
export type { JsonSchemaObject } from "../shared/json-schema.types.js";
