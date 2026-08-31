/** Builds prompt lines for a full BOOTSTRAP.md workflow handoff. */
export function buildFullBootstrapPromptLines(params: {
  readLine: string;
  firstReplyLine: string;
}): string[] {
  return [
    params.readLine,
    "Can finish BOOTSTRAP.md here: do it.",
    "Cannot: brief blocker, safe possible steps, simplest next step.",
    "Never claim completion early. No generic greeting/normal reply before BOOTSTRAP.md handling.",
    params.firstReplyLine,
  ];
}

/** Builds prompt lines for a constrained BOOTSTRAP.md workflow handoff. */
export function buildLimitedBootstrapPromptLines(params: {
  introLine: string;
  nextStepLine: string;
}): string[] {
  return [
    params.introLine,
    "Never claim complete; no generic first greeting.",
    "Brief limitation; only safe possible steps; simplest next step.",
    params.nextStepLine,
  ];
}
