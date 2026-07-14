import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { fingerprint } from "../protocol/index.js";
import { ReefChannelConfigSchema, type ReefChannelConfig } from "./config-schema.js";
import { generateAndStoreKeys, resolveStateDir } from "./state.js";
import { ReefTransportClient } from "./transport.js";

type Prompt = {
  note(message: string, title?: string): Promise<void>;
  text(params: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    sensitive?: boolean;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  select<T>(params: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T>;
};

export const reefSetupAdapter = {
  applyAccountConfig: ({
    cfg,
    input,
  }: {
    cfg: OpenClawConfig;
    accountId: string;
    input: Record<string, unknown>;
  }) =>
    ({
      ...cfg,
      channels: {
        ...cfg.channels,
        reef: { ...(cfg.channels?.reef as object), ...input, dmPolicy: "pairing" },
      },
    }) as OpenClawConfig,
};

export const reefSetupWizard = {
  channel: "reef",
  getStatus: async ({ cfg }: { cfg: OpenClawConfig }) => {
    const raw = cfg.channels?.reef as unknown;
    const parsed = ReefChannelConfigSchema.safeParse(raw ?? {});
    const configured =
      parsed.success && Boolean(parsed.data.handle && parsed.data.email && parsed.data.guard);
    return {
      channel: "reef",
      configured,
      statusLines: [configured ? `Reef @${parsed.data.handle}` : "Reef not configured"],
    };
  },
  configure: async ({ cfg }: { cfg: OpenClawConfig }) => ({ cfg }),
  configureInteractive: async ({ cfg, prompter }: { cfg: OpenClawConfig; prompter: Prompt }) => {
    const relayUrl = await prompter.text({
      message: "Reef relay URL",
      initialValue: "https://reefwire.ai",
    });
    const email = await prompter.text({
      message: "Email",
      validate: (value) => (value.includes("@") ? undefined : "Valid email required"),
    });
    let setupSession = (
      await prompter.text({
        message: "Existing setup session (optional)",
        placeholder: "Paste from reefwire.ai/welcome, or leave blank for email",
        sensitive: true,
      })
    ).trim();
    const handle = (
      await prompter.text({
        message: "Handle (without @)",
        validate: (value) =>
          /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value) ? undefined : "Invalid handle",
      })
    ).toLowerCase();
    const requestPolicy = await prompter.select({
      message: "Inbound friend-request policy",
      initialValue: "code-only" as const,
      options: [
        {
          value: "code-only" as const,
          label: "Code only (recommended)",
          hint: "Requests need an out-of-band code",
        },
        { value: "friends-of-friends" as const, label: "Friends of friends" },
        {
          value: "open" as const,
          label: "Open",
          hint: "Anyone knowing the exact handle may request",
        },
      ],
    });
    const stateDir = resolveStateDir(
      await prompter.text({
        message: "Local Reef state directory",
        initialValue: resolveStateDir(),
      }),
    );
    const keys = await generateAndStoreKeys(stateDir);
    const client = new ReefTransportClient(relayUrl, handle, keys);
    if (!setupSession) {
      const started = await client.authStart(email);
      if (started.magicLink) {
        await prompter.note(started.magicLink, "Development magic link");
      }
      const token = await prompter.text({ message: "Magic-link token", sensitive: true });
      setupSession = (await client.authComplete(token)).session;
    }
    await client.createHandle(setupSession, requestPolicy);
    const provider = await prompter.select({
      message: "Guard provider",
      options: [
        { value: "anthropic" as const, label: "Anthropic" },
        { value: "openai" as const, label: "OpenAI" },
      ],
    });
    const pinnedModel = await prompter.text({ message: "Pinned guard model snapshot" });
    const apiKeyEnv = await prompter.text({
      message: "Guard API key environment variable name",
      initialValue: provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
    });
    const policyVersion = await prompter.text({
      message: "Guard policy version",
      initialValue: "reef-v1",
    });
    const reef: ReefChannelConfig = ReefChannelConfigSchema.parse({
      relayUrl,
      handle,
      email,
      requestPolicy,
      stateDir,
      friends: {},
      dmPolicy: "pairing",
      allowFrom: [],
      guard: { provider, pinnedModel, apiKeyEnv, policyVersion, timeoutMs: 30_000 },
    });
    await prompter.note(
      fingerprint(keys.signing.publicKey, keys.encryption.publicKey),
      "Reef safety fingerprint — share out of band",
    );
    return {
      cfg: { ...cfg, channels: { ...cfg.channels, reef } } as OpenClawConfig,
      accountId: "default",
    };
  },
};
