import "./onboarding-plugin-install.js";

type OnboardingPluginInstallTestApi = {
  formatInstallErrorDetail(message: string): string;
  summarizeInstallError(message: string): string;
};

function getTestApi(): OnboardingPluginInstallTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.onboardingPluginInstallTestApi")
  ] as OnboardingPluginInstallTestApi;
}

export const testing: OnboardingPluginInstallTestApi = {
  formatInstallErrorDetail(message) {
    return getTestApi().formatInstallErrorDetail(message);
  },
  summarizeInstallError(message) {
    return getTestApi().summarizeInstallError(message);
  },
};
