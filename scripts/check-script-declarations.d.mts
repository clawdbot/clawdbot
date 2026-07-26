/// <reference types="node" />
export function generateValueExportContract(filePath: string): Buffer;
export function verifyScriptDeclarationContracts(options?: { root?: string; files?: string[] }): {
  checked: number;
  issues: string[];
};
