declare module "proper-lockfile" {
  export type RetryOptions = {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
  };

  export type LockOptions = {
    retries?: number | RetryOptions;
    stale?: number;
    update?: number;
    realpath?: boolean;
  };

  export type ReleaseFn = () => Promise<void>;

  export function lock(path: string, options?: LockOptions): Promise<ReleaseFn>;

  const lockfile: {
    lock: typeof lock;
  };

  export default lockfile;
}
