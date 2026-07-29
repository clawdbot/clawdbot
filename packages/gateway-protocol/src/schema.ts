/**
 * Public schema barrel for the gateway protocol package.
 *
 * Runtime validators import canonical TypeBox schemas from their owning modules;
 * this barrel gives package consumers one stable path for schema-level imports.
 */
export * from "./schema-modules.js";
export * from "./schema/protocol-schemas.js";
