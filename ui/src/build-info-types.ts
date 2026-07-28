export type ControlUiBuildInfo = Readonly<{
  version: string | null;
  commit: string | null;
  commitAt: string | null;
  builtAt: string | null;
  branch: string | null;
  dirty: boolean | null;
  buildId: string;
}>;
