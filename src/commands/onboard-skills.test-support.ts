import "./onboard-skills.js";

type OnboardSkillsTestApi = {
  formatSkillHint(skill: { description?: string; install: Array<{ label: string }> }): string;
  summarizeInstallFailure(message: string): string | undefined;
};

function getTestApi(): OnboardSkillsTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.onboardSkillsTestApi")
  ] as OnboardSkillsTestApi;
}

export const testing: OnboardSkillsTestApi = {
  formatSkillHint(skill) {
    return getTestApi().formatSkillHint(skill);
  },
  summarizeInstallFailure(message) {
    return getTestApi().summarizeInstallFailure(message);
  },
};
