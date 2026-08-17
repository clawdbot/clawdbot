// Defines agent model selection schema fragments.
import { z } from "zod";

/** Schema for agent model config accepting a string or fallback object. */
/** Opt-in route circuit breaker for the model fallback chain. */
const ModelCircuitBreakerSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      circuitBreaker: ModelCircuitBreakerSchema.optional(),
    })
    .strict(),
]);

export const AgentToolModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
