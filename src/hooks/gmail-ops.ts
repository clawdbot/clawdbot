import { spawn } from "node:child_process";

import {
  type ClawdbotConfig,
  CONFIG_PATH_CLAWDBOT,
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
  validateConfigObject,
  writeConfigFile,
} from "../config/config.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import {
  buildDefaultHookUrl,
  buildGogWatchServeArgs,
  buildGogWatchStartArgs,
  buildTopicPath,
  DEFAULT_GMAIL_LABEL,
  DEFAULT_GMAIL_MAX_BYTES,
  DEFAULT_GMAIL_RENEW_MINUTES,
  DEFAULT_GMAIL_SERVE_BIND,
  DEFAULT_GMAIL_SERVE_PATH,
  DEFAULT_GMAIL_SERVE_PORT,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_TOPIC,
  type GmailHookOverrides,
  type GmailHookRuntimeConfig,
  generateHookToken,
  mergeHookPresets,
  normalizeHooksPath,
  normalizeServePath,
  parseTopicPath,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";
import {
  ensureDependency,
  ensureGcloudAuth,
  ensureSubscription,
  ensureTailscaleEndpoint,
  ensureTopic,
  resolveProjectIdFromGogCredentials,
  runGcloud,
} from "./gmail-setup-utils.js";

export type GmailSetupOptions = {
  account: string;
  project?: string;
  topic?: string;
  subscription?: string;
  label?: string;
  hookToken?: string;
  pushToken?: string;
  hookUrl?: string;
  bind?: string;
  port?: number;
  path?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  tailscale?: "off" | "serve" | "funnel";
  tailscalePath?: string;
  tailscaleTarget?: string;
  pushEndpoint?: string;
  json?: boolean;
};

export type GmailRunOptions = {
  account?: string;
  topic?: string;
  subscription?: string;
  label?: string;
  hookToken?: string;
  pushToken?: string;
  hookUrl?: string;
  bind?: string;
  port?: number;
  path?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  tailscale?: "off" | "serve" | "funnel";
  tailscalePath?: string;
  tailscaleTarget?: string;
};

const DEFAULT_GMAIL_TOPIC_IAM_MEMBER =
  "serviceAccount:gmail-api-push@system.gserviceaccount.com";

export async function runGmailSetup(opts: GmailSetupOptions) {
  await ensureDependency("gcloud", ["--cask", "gcloud-cli"]);
  await ensureDependency("gog", ["gogcli"]);
  if (opts.tailscale !== "off" && !opts.pushEndpoint) {
    await ensureDependency("tailscale", ["tailscale"]);
  }

  await ensureGcloudAuth();

  const configSnapshot = await readConfigFileSnapshot();
  if (!configSnapshot.valid) {
    throw new Error(`Config invalid: ${CONFIG_PATH_CLAWDBOT}`);
  }

  const baseConfig = configSnapshot.config;
  const hooksPath = normalizeHooksPath(baseConfig.hooks?.path);
  const hookToken =
    opts.hookToken ?? baseConfig.hooks?.token ?? generateHookToken();
  const pushToken =
    opts.pushToken ?? baseConfig.hooks?.gmail?.pushToken ?? generateHookToken();

  const topicInput =
    opts.topic ?? baseConfig.hooks?.gmail?.topic ?? DEFAULT_GMAIL_TOPIC;
  const parsedTopic = parseTopicPath(topicInput);
  const topicName = parsedTopic?.topicName ?? topicInput;

  const projectId =
    opts.project ??
    parsedTopic?.projectId ??
    (await resolveProjectIdFromGogCredentials());
  // Gmail watch requires the Pub/Sub topic to live in the OAuth client project.
  if (!projectId) {
    throw new Error(
      "GCP project id required (use --project or ensure gog credentials are available)",
    );
  }

  const topicPath = buildTopicPath(projectId, topicName);

  const subscription = opts.subscription ?? DEFAULT_GMAIL_SUBSCRIPTION;
  const label = opts.label ?? DEFAULT_GMAIL_LABEL;
  const hookUrl =
    opts.hookUrl ??
    baseConfig.hooks?.gmail?.hookUrl ??
    buildDefaultHookUrl(hooksPath, resolveGatewayPort(baseConfig));

  const serveBind = opts.bind ?? DEFAULT_GMAIL_SERVE_BIND;
  const servePort = opts.port ?? DEFAULT_GMAIL_SERVE_PORT;
  const configuredServePath = opts.path ?? baseConfig.hooks?.gmail?.serve?.path;
  const configuredTailscaleTarget =
    opts.tailscaleTarget ?? baseConfig.hooks?.gmail?.tailscale?.target;
  const normalizedServePath =
    typeof configuredServePath === "string" &&
    configuredServePath.trim().length > 0
      ? normalizeServePath(configuredServePath)
      : DEFAULT_GMAIL_SERVE_PATH;
  const normalizedTailscaleTarget =
    typeof configuredTailscaleTarget === "string" &&
    configuredTailscaleTarget.trim().length > 0
      ? configuredTailscaleTarget.trim()
      : undefined;

  const includeBody = opts.includeBody ?? true;
  const maxBytes = opts.maxBytes ?? DEFAULT_GMAIL_MAX_BYTES;
  const renewEveryMinutes =
    opts.renewEveryMinutes ?? DEFAULT_GMAIL_RENEW_MINUTES;

  const tailscaleMode = opts.tailscale ?? "funnel";
  // Tailscale strips the path before proxying; keep a public path while gog
  // listens on "/" whenever Tailscale is enabled.
  const servePath = normalizeServePath(
    tailscaleMode !== "off" && !normalizedTailscaleTarget
      ? "/"
      : normalizedServePath,
  );
  const tailscalePath = normalizeServePath(
    opts.tailscalePath ??
      baseConfig.hooks?.gmail?.tailscale?.path ??
      (tailscaleMode !== "off" ? normalizedServePath : servePath),
  );

  await runGcloud(["config", "set", "project", projectId, "--quiet"]);
  await runGcloud([
    "services",
    "enable",
    "gmail.googleapis.com",
    "pubsub.googleapis.com",
    "--project",
    projectId,
    "--quiet",
  ]);

  await ensureTopic(projectId, topicName);
  await runGcloud([
    "pubsub",
    "topics",
    "add-iam-policy-binding",
    topicName,
    "--project",
    projectId,
    "--member",
    DEFAULT_GMAIL_TOPIC_IAM_MEMBER,
    "--role",
    "roles/pubsub.publisher",
    "--quiet",
  ]);

  const pushEndpoint = opts.pushEndpoint
    ? opts.pushEndpoint
    : await ensureTailscaleEndpoint({
        mode: tailscaleMode,
        path: tailscalePath,
        port: servePort,
        target: normalizedTailscaleTarget,
        token: pushToken,
      });

  if (!pushEndpoint) {
    throw new Error("push endpoint required (set --push-endpoint)");
  }

  await ensureSubscription(projectId, subscription, topicName, pushEndpoint);

  await startGmailWatch(
    {
      account: opts.account,
      label,
      topic: topicPath,
    },
    true,
  );

  const nextConfig: ClawdbotConfig = {
    ...baseConfig,
    hooks: {
      ...baseConfig.hooks,
      enabled: true,
      path: hooksPath,
      token: hookToken,
      presets: mergeHookPresets(baseConfig.hooks?.presets, "gmail"),
      gmail: {
        ...baseConfig.hooks?.gmail,
        account: opts.account,
        label,
        topic: topicPath,
        subscription,
        pushToken,
        hookUrl,
        includeBody,
        maxBytes,
        renewEveryMinutes,
        serve: {
          ...baseConfig.hooks?.gmail?.serve,
          bind: serveBind,
          port: servePort,
          path: servePath,
        },
        tailscale: {
          ...baseConfig.hooks?.gmail?.tailscale,
          mode: tailscaleMode,
          path: tailscalePath,
          target: normalizedTailscaleTarget,
        },
      },
    },
  };

  const validated = validateConfigObject(nextConfig);
  if (!validated.ok) {
    throw new Error(
      `Config validation failed: ${validated.issues[0]?.message ?? "invalid"}`,
    );
  }
  await writeConfigFile(validated.config);

  const summary = {
    projectId,
    topic: topicPath,
    subscription,
    pushEndpoint,
    hookUrl,
    hookToken,
    pushToken,
    serve: {
      bind: serveBind,
      port: servePort,
      path: servePath,
    },
  };

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(summary, null, 2));
    return;
  }

  defaultRuntime.log("Gmail hooks configured:");
  defaultRuntime.log(`- project: ${projectId}`);
  defaultRuntime.log(`- topic: ${topicPath}`);
  defaultRuntime.log(`- subscription: ${subscription}`);
  defaultRuntime.log(`- push endpoint: ${pushEndpoint}`);
  defaultRuntime.log(`- hook url: ${hookUrl}`);
  defaultRuntime.log(`- config: ${CONFIG_PATH_CLAWDBOT}`);
  defaultRuntime.log("Next: clawdbot hooks gmail run");
}

export async function runGmailService(opts: GmailRunOptions) {
  await ensureDependency("gog", ["gogcli"]);
  const config = loadConfig();

  const overrides: GmailHookOverrides = {
    account: opts.account,
    topic: opts.topic,
    subscription: opts.subscription,
    label: opts.label,
    hookToken: opts.hookToken,
    pushToken: opts.pushToken,
    hookUrl: opts.hookUrl,
    serveBind: opts.bind,
    servePort: opts.port,
    servePath: opts.path,
    includeBody: opts.includeBody,
    maxBytes: opts.maxBytes,
    renewEveryMinutes: opts.renewEveryMinutes,
    tailscaleMode: opts.tailscale,
    tailscalePath: opts.tailscalePath,
    tailscaleTarget: opts.tailscaleTarget,
  };

  const resolved = resolveGmailHookRuntimeConfig(config, overrides);
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }

  const runtimeConfig = resolved.value;

  if (runtimeConfig.tailscale.mode !== "off") {
    await ensureDependency("tailscale", ["tailscale"]);
    await ensureTailscaleEndpoint({
      mode: runtimeConfig.tailscale.mode,
      path: runtimeConfig.tailscale.path,
      port: runtimeConfig.serve.port,
      target: runtimeConfig.tailscale.target,
    });
  }

  await startGmailWatch(runtimeConfig);

  let shuttingDown = false;
  let child = spawnGogServe(runtimeConfig);

  const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
  const renewTimer = setInterval(() => {
    void startGmailWatch(runtimeConfig);
  }, renewMs);

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(renewTimer);
    child.kill("SIGTERM");
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  child.on("exit", () => {
    if (shuttingDown) return;
    defaultRuntime.log("gog watch serve exited; restarting in 2s");
    setTimeout(() => {
      if (shuttingDown) return;
      child = spawnGogServe(runtimeConfig);
    }, 2000);
  });
}

function spawnGogServe(cfg: GmailHookRuntimeConfig) {
  const args = buildGogWatchServeArgs(cfg);
  defaultRuntime.log(`Starting gog ${args.join(" ")}`);
  return spawn("gog", args, { stdio: "inherit" });
}

async function startGmailWatch(
  cfg: Pick<GmailHookRuntimeConfig, "account" | "label" | "topic">,
  fatal = false,
) {
  const args = ["gog", ...buildGogWatchStartArgs(cfg)];
  const result = await runCommandWithTimeout(args, { timeoutMs: 120_000 });
  if (result.code !== 0) {
    const message = result.stderr || result.stdout || "gog watch start failed";
    if (fatal) throw new Error(message);
    defaultRuntime.error(message);
  }
}
