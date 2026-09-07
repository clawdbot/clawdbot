// Shared wizard translation schema: a tiny dotted-key tree plus primitive
// interpolation params for setup/onboard copy.
export type WizardLocale = "en" | "zh-CN" | "zh-TW";

export type WizardI18nParams = Record<string, boolean | number | string | null | undefined>;

export type WizardTranslationTree = {
  readonly [key: string]: string | WizardTranslationTree;
};

export type WizardTranslationMap = WizardTranslationTree;
