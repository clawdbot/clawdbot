export type IosScreenshotTooling = {
  xcode: string;
  fastlane: string;
  node: string;
};

export type IosScreenshotProvenance = {
  targetSha: string;
  workflowSha: string;
  runId: string;
  runAttempt: string | number;
  tooling: IosScreenshotTooling;
};

export type XcresultSummary = {
  testResult: string;
  failedTests: number;
};

export function collectIosScreenshotEvidence(options: {
  family: string;
  screenshotDirectory: string;
  xcresultDirectory: string;
  outputDirectory: string;
  provenance: IosScreenshotProvenance;
  readXcresultSummary?: (resultPath: string) => XcresultSummary;
}): Record<string, unknown>;

export function reduceIosScreenshotEvidence(options: {
  inputDirectory: string;
  outputRoot: string;
  expectedProvenance: IosScreenshotProvenance;
}): Record<string, unknown>;
