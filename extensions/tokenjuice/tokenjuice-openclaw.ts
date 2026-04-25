declare module "tokenjuice/openclaw" {
  type OpenClawPiRuntime = {
    on(event: string, handler: (event: unknown, ctx: { cwd: string }) => unknown): void;
  };

  export function createTokenjuiceOpenClawEmbeddedExtension(): (pi: OpenClawPiRuntime) => void;
}
