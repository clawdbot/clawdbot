export type WizardLocale = "en" | "zh-CN" | "zh-TW";

export type WizardI18nParams = Record<string, boolean | number | string | null | undefined>;

export type WizardTranslationTree = {
  readonly [key: string]: string | WizardTranslationTree;
};

export type WizardTranslationMap = WizardTranslationTree;
