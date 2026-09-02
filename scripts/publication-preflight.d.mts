export const DEFAULT_REPOSITORY: "openclaw/openclaw";
export const DEFAULT_REMOTE: "origin";
export const DEFAULT_BASE: "main";
export const MANIFEST_VERSION: 1;

export class PublicationPreflightError extends Error {}

export function parseArgs(argv?: string[]): {
  command: "prepare" | "check" | "approve" | "hook" | "help";
  manifest: string | null;
  repository: string;
  remote: string;
  remoteName: string | null;
  remoteUrl: string | null;
  base: string;
  upstream: string | null;
  paths: string[];
  privateNames: string[];
  approvedEmails: string[];
  strategy: "new_independent" | "update_existing" | "supersede_existing";
  existingPr: number | null;
  supersedesPr: number | null;
  supersedesReason: string | null;
  disposition: string | null;
  inventoryFile: string | null;
  inventoryJson: string | null;
  quiet: boolean;
};

export function isApprovedNoReplyEmail(email: string): boolean;
export function collectOpenPrInventory(
  repository: string,
  options?: {
    execFileSync?: (
      file: string,
      args: string[],
      options: {
        encoding: "utf8";
        stdio: ["ignore", "pipe", "pipe"];
        maxBuffer: number;
      },
    ) => string;
  },
): Array<{
  number: number;
  repository: string;
  author: string;
  branch: string;
  title: string;
  url: string | null;
  paths: string[];
}>;
export function scanSecurityText(
  text: string,
  options?: { privateNames?: string[] },
): Array<{ kind: string; line: number }>;
export function validateInventory(manifest: Record<string, unknown>, changedPaths: string[]): void;
export function main(argv?: string[], options?: { cwd?: string; stdin?: string }): void;
