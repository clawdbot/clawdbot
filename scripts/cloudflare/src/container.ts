import { Container } from "@cloudflare/containers";

interface OpenClawContainerEnv {
  ANTHROPIC_API_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  LITESTREAM_ACCESS_KEY_ID: string;
  LITESTREAM_BUCKET: string;
  LITESTREAM_ENDPOINT: string;
  LITESTREAM_REGION: string;
  LITESTREAM_SECRET_ACCESS_KEY: string;
  OPENAI_API_KEY?: string;
  OPENCLAW_GATEWAY_TOKEN: string;
  OPENCLAW_WEBHOOK_ONLY: string;
  SLACK_APP_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
}

const OPTIONAL_SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "DISCORD_BOT_TOKEN",
  "OPENAI_API_KEY",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
] as const;

function buildContainerEnv(env: OpenClawContainerEnv): Record<string, string> {
  const containerEnv: Record<string, string> = {
    LITESTREAM_ACCESS_KEY_ID: env.LITESTREAM_ACCESS_KEY_ID,
    LITESTREAM_BUCKET: env.LITESTREAM_BUCKET,
    LITESTREAM_ENDPOINT: env.LITESTREAM_ENDPOINT,
    LITESTREAM_REGION: env.LITESTREAM_REGION,
    LITESTREAM_SECRET_ACCESS_KEY: env.LITESTREAM_SECRET_ACCESS_KEY,
    OPENCLAW_GATEWAY_TOKEN: env.OPENCLAW_GATEWAY_TOKEN,
  };

  for (const [name, value] of Object.entries(containerEnv)) {
    if (!value) {
      throw new Error(`missing required Worker variable or secret: ${name}`);
    }
  }

  for (const name of OPTIONAL_SECRET_NAMES) {
    const value = env[name];
    if (value) {
      containerEnv[name] = value;
    }
  }

  return containerEnv;
}

export class OpenClawContainer extends Container<OpenClawContainerEnv> {
  override defaultPort = 8080;
  // /healthz exists in every published OpenClaw image and answers as soon as the
  // Gateway's listener is up, which is exactly what this readiness poll asks.
  // Do not point this at a route the pinned image may not serve: the Control UI
  // answers unknown paths with a catch-all 200, so a missing route would look
  // permanently healthy instead of failing. /startupz additionally waits for
  // startup work to finish and is the better signal once the derived image comes
  // from a release that serves it.
  override pingEndpoint = "localhost/healthz";
  override sleepAfter = "10m";

  private readonly webhookOnly: boolean;

  constructor(ctx: unknown, env: OpenClawContainerEnv) {
    super(ctx, env);
    this.envVars = buildContainerEnv(env);
    this.webhookOnly = env.OPENCLAW_WEBHOOK_ONLY === "true";
  }

  override async onActivityExpired(): Promise<void> {
    // Socket channels need a continuously running process. Only an explicitly
    // webhook-only installation may let the Container helper stop the instance.
    if (this.webhookOnly) {
      await super.onActivityExpired();
    }
  }
}
