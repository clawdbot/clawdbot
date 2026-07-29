#!/usr/bin/env node
/**
 * Removes build output roots while preserving explicitly protected artifacts.
 */
export function cleanTsdownOutputRoots(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: typeof import("node:fs");
  roots?: string[];
}): void;
export function pruneStaleRootChunkFiles(params?: Record<string, unknown>): void;
export function listTsdownOutputRoots(): string[];
export function resolveTsdownCleanOutputRoots(args?: string[]): string[];
export function pruneUntrackedGeneratedSourceDeclarations(params?: Record<string, unknown>): number;
export function pruneSourceCheckoutBundledPluginNodeModules(params?: Record<string, unknown>): void;
export function parseTsdownBuildArgs(argv: unknown): {
  forwardedArgs: unknown;
  help: boolean;
};
export function createTsdownOutputScanner(params?: Record<string, unknown>): {
  append(chunk: unknown): void;
  finish(): {
    captured: string;
    hasIneffectiveDynamicImport: boolean;
    fatalUnresolvedImport: unknown;
  };
};
export function resolveTsdownBuildInvocation(params?: Record<string, unknown>):
  | {
      command: unknown;
      args: unknown[];
      options: {
        stdio: string[];
        shell: boolean;
        windowsVerbatimArguments: undefined;
        env: NodeJS.ProcessEnv;
      };
    }
  | {
      command: string;
      args: string[];
      options: {
        stdio: string[];
        shell: boolean;
        windowsVerbatimArguments: boolean | undefined;
        env: NodeJS.ProcessEnv;
      };
    };
/** Builds AI package declarations first, then consumes them from the main graph. */
export function resolveTsdownBuildInvocations(params?: Record<string, unknown>): (
  | {
      command: unknown;
      args: unknown[];
      options: {
        stdio: string[];
        shell: boolean;
        windowsVerbatimArguments: undefined;
        env: NodeJS.ProcessEnv;
      };
    }
  | {
      command: string;
      args: string[];
      options: {
        stdio: string[];
        shell: boolean;
        windowsVerbatimArguments: boolean | undefined;
        env: NodeJS.ProcessEnv;
      };
    }
)[];
export function signalTsdownBuildProcessTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals): unknown },
  signal: NodeJS.Signals,
  {
    platform,
    runTaskkill,
    useProcessGroup,
  }?: {
    platform?: NodeJS.Platform | undefined;
    runTaskkill?:
      | ((
          command: string,
          args: string[],
          options: { stdio: "ignore" },
        ) => { error?: Error; status: number | null })
      | undefined;
    useProcessGroup?: boolean | undefined;
  },
): void;
export function runTsdownBuildInvocation(
  invocation: unknown,
  params?: Record<string, unknown>,
): Promise<{
  captured: string;
  hasIneffectiveDynamicImport: boolean;
  signal: NodeJS.Signals | null;
  status: number | null;
  timedOut: boolean;
}>;
