import type { Static } from "typebox";
import { Type } from "typebox";
import { FAILOVER_REASONS } from "../failover-reasons.js";

/** Closed failure reasons shared by model fallback producers and protocol consumers.
 * The literal list stays explicit because Type.Union needs a tuple for
 * Static inference (a mapped array collapses Static to never); the guard
 * below keeps it in lockstep with FAILOVER_REASONS. */
export const FailoverReasonSchema = Type.Union([
  Type.Literal("auth"),
  Type.Literal("auth_permanent"),
  Type.Literal("format"),
  Type.Literal("rate_limit"),
  Type.Literal("overloaded"),
  Type.Literal("billing"),
  Type.Literal("server_error"),
  Type.Literal("timeout"),
  Type.Literal("tls_certificate"),
  Type.Literal("context_overflow"),
  Type.Literal("model_not_found"),
  Type.Literal("session_expired"),
  Type.Literal("empty_response"),
  Type.Literal("no_error_details"),
  Type.Literal("unclassified"),
  Type.Literal("unknown"),
]);

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const failoverReasonVocabularyInSync: MutuallyAssignable<
  Static<typeof FailoverReasonSchema>,
  (typeof FAILOVER_REASONS)[number]
> = true;
void failoverReasonVocabularyInSync;
