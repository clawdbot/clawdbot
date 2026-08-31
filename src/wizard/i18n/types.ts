// Shared wizard translation schema: a tiny dotted-key tree plus primitive
// interpolation params for setup/onboard copy.
export type WizardLocale = "en" | "zh-CN" | "zh-TW";

export type WizardI18nParams = Record<string, boolean | number | string | null | undefined>;

export type WizardTranslationTree = {
  readonly [key: string]: string | WizardTranslationTree;
};

export type WizardTranslationMap = WizardTranslationTree & {
  readonly wizard: WizardTranslationTree & {
    readonly guided: WizardTranslationTree & {
      readonly quickstartSilentFailures: string;
      readonly laneQuestion: string;
      readonly laneQuickLabel: string;
      readonly laneQuickHint: string;
      readonly laneCustomLabel: string;
      readonly laneCustomHint: string;
      readonly quickstartRoute: string;
      readonly quickstartManual: string;
      readonly quickstartDashboard: string;
      readonly quickstartForeground: string;
      readonly quickstartBackground: string;
      readonly quickstartReopen: string;
      readonly quickstartBrowserUnavailable: string;
      readonly quickstartGatewayPending: string;
    };
  };
};
