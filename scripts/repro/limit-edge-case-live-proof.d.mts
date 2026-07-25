export function withProofTempRoot<T>(callback: (root: string) => T | Promise<T>): Promise<T>;
