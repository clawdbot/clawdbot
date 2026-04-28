/**
 * Local type declaration for global-agent.
 *
 * The package ships TypeScript types in dist/index.d.ts but omits the
 * "types" field in package.json, so TypeScript cannot resolve them
 * automatically. This shim re-exports the types that OpenClaw uses.
 */
declare module "global-agent" {
  /**
   * Bootstraps global-agent by monkey-patching node:http and node:https.
   * Must be called once before any HTTP requests are made.
   * Reads proxy URL from global.GLOBAL_AGENT.HTTP_PROXY / HTTPS_PROXY at runtime.
   */
  export function bootstrap(): void;

  /**
   * Creates a standalone proxy agent instance without setting global.GLOBAL_AGENT.
   */
  export function createGlobalProxyAgent(config?: {
    environmentVariableNamespace?: string;
    forceGlobalAgent?: boolean;
    socketConnectionTimeout?: number;
  }): {
    HTTP_PROXY: string | null;
    HTTPS_PROXY: string | null;
    NO_PROXY: string | null;
  };
}
