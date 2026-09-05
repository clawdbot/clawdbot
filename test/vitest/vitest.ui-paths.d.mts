export const uiNodeDrivenBrowserTestFiles: string[];
export function isUiBrowserTestFile(relative: string): boolean;
export const pluginControlUiPathGlob: "extensions/*/browser/**";
export const controlUiTestGlobs: string[];
export const controlUiE2eTestGlobs: string[];
export function isPluginControlUiPath(file: string): boolean;
export function isControlUiSourcePath(file: string): boolean;
export function isUiTestTarget(relative: string): boolean;
