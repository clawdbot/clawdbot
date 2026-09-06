// Keep this deployment template type-checkable without adding Cloudflare packages
// to the OpenClaw workspace. The isolated package.json supplies the runtime module.
declare module "@cloudflare/containers" {
  export class Container<Env = unknown> {
    constructor(ctx: unknown, env: Env);
    defaultPort?: number;
    envVars: Record<string, string>;
    pingEndpoint: string;
    sleepAfter: string | number;
    fetch(request: Request): Promise<Response>;
    onActivityExpired(): Promise<void>;
  }
}
