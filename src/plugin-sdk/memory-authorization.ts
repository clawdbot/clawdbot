/**
 * Versioned multiplayer-memory authorization contracts and pure backend conformance helpers.
 *
 * These shapes are serializable. Only core can create a branded trusted context or admit a
 * plugin-issued plan; serializing one of these values does not preserve that trust.
 */
export * from "../../packages/memory-host-sdk/src/authorization.js";
export * from "../../packages/memory-host-sdk/src/authorization-conformance.js";
