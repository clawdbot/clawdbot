export type BootstrapTruncationCause = "per-file-limit" | "total-limit";
export type BootstrapPromptWarningMode = "off" | "once" | "always";

export type BootstrapInjectionStat = {
  name: string;
  path: string;
  missing: boolean;
  rawChars: number;
  injectedChars: number;
  truncated: boolean;
};

type BootstrapAnalyzedFile = BootstrapInjectionStat & {
  effectiveFileLimit: number;
  nearLimit: boolean;
  causes: BootstrapTruncationCause[];
};

export type BootstrapBudgetAnalysis = {
  files: BootstrapAnalyzedFile[];
  truncatedFiles: BootstrapAnalyzedFile[];
  nearLimitFiles: BootstrapAnalyzedFile[];
  totalNearLimit: boolean;
  hasTruncation: boolean;
  totals: {
    rawChars: number;
    injectedChars: number;
    truncatedChars: number;
    bootstrapMaxChars: number;
    bootstrapTotalMaxChars: number;
    nearLimitRatio: number;
  };
};

export type BootstrapPromptWarning = {
  signature?: string;
  warningShown: boolean;
  lines: string[];
  warningSignaturesSeen: string[];
};
