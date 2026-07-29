/**
 * Inbound pipeline stages — each stage is a pure(-ish) function that
 * transforms a subset of the pipeline's state. The main `inbound-pipeline`
 * module composes them in order.
 *
 * Keeping every stage in its own file makes the pipeline's control flow
 * obvious and lets each piece be unit-tested against tiny input fixtures
 * without spinning up the full gateway.
 */

export * from "./access-stage.js";
export * from "./assembly-stage.js";
export * from "./content-stage.js";
export * from "./envelope-stage.js";
export * from "./group-gate-stage.js";
export * from "./quote-stage.js";
export * from "./refidx-stage.js";
export { buildSkippedInboundContext } from "./stub-contexts.js";
