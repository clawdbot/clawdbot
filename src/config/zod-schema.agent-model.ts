// Defines agent model selection schema fragments.
import { z } from "zod";

/** Schema for agent model config accepting a string or fallback object. */
/** Opt-in route circuit breaker for the model fallback chain. */
const ModelCircuitBreakerSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

const agentModelShape = {
  primary: z.string().optional(),
  fallbacks: z.array(z.string()).optional(),
};

export const AgentModelSchema = z.union([z.string(), z.object(agentModelShape).strict()]);

/**
 * `agents.defaults.model` additionally accepts the route circuit breaker
 * switch. The circuit is process-global (keyed by agent dir, provider, and
 * model), so it is only honored here rather than on every model chain.
 */
export const AgentDefaultModelSchema = z.union([
  z.string(),
  z
    .object({
      ...agentModelShape,
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
