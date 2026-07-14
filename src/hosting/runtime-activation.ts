import { randomUUID } from "node:crypto";

export const RUNTIME_ID_ENV = "OPENCLAW_RUNTIME_ID";
export const INCARNATION_ID_ENV = "OPENCLAW_INCARNATION_ID";

const ACTIVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PROCESS_INCARNATION_ID = randomUUID();

export type RuntimeActivationIdentity = {
  runtimeId: string;
  incarnationId: string;
};

function resolveActivationId(params: {
  value: string | undefined;
  fallback: () => string;
  label: string;
}): string {
  const value = params.value === undefined ? params.fallback() : params.value.trim();
  if (!ACTIVATION_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${params.label}: expected 1-128 characters using letters, numbers, '.', '_', ':', '/', or '-'.`,
    );
  }
  return value;
}

export function resolveRuntimeActivationIdentity(
  params: {
    env?: NodeJS.ProcessEnv;
    runtimeId?: string;
    incarnationId?: string;
    createIncarnationId?: () => string;
  } = {},
): RuntimeActivationIdentity {
  const env = params.env ?? process.env;
  return {
    runtimeId: resolveActivationId({
      value: params.runtimeId ?? env[RUNTIME_ID_ENV],
      fallback: () => "local",
      label: RUNTIME_ID_ENV,
    }),
    incarnationId: resolveActivationId({
      value: params.incarnationId ?? env[INCARNATION_ID_ENV],
      fallback: params.createIncarnationId ?? (() => PROCESS_INCARNATION_ID),
      label: INCARNATION_ID_ENV,
    }),
  };
}
