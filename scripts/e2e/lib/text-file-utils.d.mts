export function tailText(text: string, maxBytes: number): string;
export function readTextFileTail(file: string, maxBytes: number): string;
export function readTextFileBounded(
  file: string,
  label: string,
  maxBytes: number,
  options?: { tailBytes?: number },
): string;
