export type UnitFastFileAnalysis = {
  file: string;
  unitFast: boolean;
  forced: boolean;
  reasons: string[];
};

export type UnitFastAnalysisOptions = {
  scope?: "default" | "broad";
};

export const forcedUnitFastTestFiles: string[];
export function classifyUnitFastTestFileContent(source: string): string[];
export function collectUnitFastTestCandidates(cwd?: string): string[];
export function collectBroadUnitFastTestCandidates(cwd?: string): string[];
export function collectUnitFastTestFileAnalysis(
  cwd?: string,
  options?: UnitFastAnalysisOptions,
): UnitFastFileAnalysis[];
export function getUnitFastTestFilesForIncludePatterns(
  includePatterns: string[],
  options?: { dir?: string },
): string[];
export function getUnitFastTestFiles(): string[];
export function getUnitFastTimerTestFiles(): string[];
export function isUnitFastTestFile(file: string): boolean;
export function isUnitFastTimerTestFile(file: string): boolean;
export function resolveUnitFastTestIncludePattern(file: string): string | null;
export function resolveUnitFastTimerTestIncludePattern(file: string): string | null;
