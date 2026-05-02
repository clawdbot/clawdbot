export {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "./local-build-metadata-paths.mjs";

export function resolveGitHead(params?: {
  cwd?: string;
  spawnSync?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => { status: number | null; stdout?: string | null };
}): string | null;

export function writeBuildStamp(params?: {
  cwd?: string;
  fs?: {
    mkdirSync(path: string, options?: { recursive?: boolean }): void;
    writeFileSync(path: string, data: string, encoding?: string): void;
  };
  now?: () => number;
  spawnSync?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => { status: number | null; stdout?: string | null };
}): string;

export function writeRuntimePostBuildStamp(params?: {
  cwd?: string;
  fs?: {
    mkdirSync(path: string, options?: { recursive?: boolean }): void;
    writeFileSync(path: string, data: string, encoding?: string): void;
  };
  now?: () => number;
  spawnSync?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => { status: number | null; stdout?: string | null };
}): string;
