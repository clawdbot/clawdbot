import { z } from "zod";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

const runtimeConfigSchema = z
  .object({
    gateway: z
      .object({
        mode: z.literal("local"),
        port: z.number().int().min(1).max(65_535).optional(),
      })
      .passthrough(),
    agents: z
      .object({
        defaults: z
          .object({
            model: z.string().min(1).optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function createReturnCovenantFixtureConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        continuation: {
          ...config.agents?.defaults?.continuation,
          enabled: true,
          crossSessionTargeting: "disabled",
        },
      },
    },
  };
}

/**
 * Project only the fields the fixture process consumes. The trusted launcher
 * binds the full config bytes; compatibility and plugin fields remain owned by
 * the distinct real gateway that opens the same file.
 */
export function projectReturnCovenantRuntimeConfig(raw: unknown): OpenClawConfig {
  const parsed = runtimeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("return-covenant runtime config is not a valid local gateway config");
  }
  const model = parsed.data.agents?.defaults.model;
  return {
    gateway: {
      mode: "local",
      ...(parsed.data.gateway.port ? { port: parsed.data.gateway.port } : {}),
    },
    ...(model ? { agents: { defaults: { model } } } : {}),
  };
}
