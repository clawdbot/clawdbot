import { Type, type TLiteral } from "typebox";
import { FAILOVER_REASONS } from "../failover-reasons.js";

type LiteralSchemas<Values extends readonly string[]> = {
  -readonly [Index in keyof Values]: Values[Index] extends string ? TLiteral<Values[Index]> : never;
};

// Array.map widens tuples, so retain the one-to-one literal schema types after
// deriving the runtime anyOf list from the canonical frozen vocabulary.
const failoverReasonLiteralSchemas = FAILOVER_REASONS.map((reason) =>
  Type.Literal(reason),
) as LiteralSchemas<typeof FAILOVER_REASONS>;

/** Closed failure reasons shared by model fallback producers and protocol consumers. */
export const FailoverReasonSchema = Type.Union(failoverReasonLiteralSchemas);
