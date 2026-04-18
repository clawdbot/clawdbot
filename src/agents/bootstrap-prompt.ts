export function buildFullBootstrapPromptLines(params: {
  readLine: string;
  firstReplyLine: string;
}): string[] {
  return [
    params.readLine,
    "If this run can complete the BOOTSTRAP.md workflow, do so.",
    "If it cannot, explain the blocker briefly, continue with any bootstrap steps that are still possible here, and offer the simplest next step.",
    "Do not pretend bootstrap is complete when it is not.",
    "Do not use a generic first greeting or reply normally until after you have handled BOOTSTRAP.md.",
    params.firstReplyLine,
  ];
}

export function buildLimitedBootstrapPromptLines(params: {
  introLine: string;
  nextStepLine: string;
}): string[] {
  return [
    params.introLine,
    "Do not claim bootstrap is complete, and do not use a generic first greeting.",
    "Briefly explain the limitation, continue only with any bootstrap steps that are still safely possible here, and offer the simplest next step.",
    params.nextStepLine,
  ];
}
