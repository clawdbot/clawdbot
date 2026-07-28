const EXPERIMENTAL_CLAWS_ENV = "OPENCLAW_EXPERIMENTAL_CLAWS";

export function isExperimentalClawsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EXPERIMENTAL_CLAWS_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function assertExperimentalClawsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (isExperimentalClawsEnabled(env)) {
    return;
  }
  throw new Error(
    `Claws are experimental and disabled. Set ${EXPERIMENTAL_CLAWS_ENV}=1 for this process to enable the unstable feature.`,
  );
}
