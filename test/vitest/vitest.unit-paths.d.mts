export const unitTestIncludePatterns: string[];
export const boundaryTestFiles: string[];
export const bundledPluginDependentUnitTestFiles: string[];
export const unitTestAdditionalExcludePatterns: string[];
export function isUnitConfigTestFile(file: string): boolean;
export function isBundledPluginDependentUnitTestFile(file: string): boolean;
export function isBoundaryTestFile(file: string): boolean;
