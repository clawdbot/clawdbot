import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { fingerprint } from "../protocol/index.js";
import {
  parseReefRelayUrl,
  ReefChannelConfigSchema,
  type ReefChannelConfig,
} from "./config-schema.js";
import { assertLegacyReefKeysMigrated } from "./legacy-key-guard.js";
import { getReefRuntime } from "./runtime.js";
import {
  finalizeReefIdentityBinding,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  releaseReefIdentityReservation,
  reserveReefIdentityBinding,
} from "./state.js";
import {
  isDefinitiveReefRegistrationFailure,
  isReefOwnershipRejection,
  ReefTransportClient,
} from "./transport.js";

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
        reef: { ...(cfg.channels?.reef as object), ...input },
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
    const rawRelayUrl = await prompter.text({
      message: "Reef relay origin URL",
      initialValue: "https://reefwire.ai",
      validate: (value) => {
        const parsed = ReefChannelConfigSchema.safeParse({ relayUrl: value });
        return parsed.success
          ? undefined
          : (parsed.error.issues.find((issue) => issue.path[0] === "relayUrl")?.message ??
              "Valid Reef relay origin required");
      },
    });
    const relayUrl = parseReefRelayUrl(rawRelayUrl);
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
    const runtime = getReefRuntime();
    const identity = loadReefIdentityBinding(runtime);
    if (identity && (identity.handle !== handle || identity.relayUrl !== relayUrl)) {
      throw new Error(
        `This OpenClaw state already holds the Reef identity @${identity.handle} on ${identity.relayUrl}. Re-register the same handle and relay.`,
      );
    }
    const configuredStateDir = (cfg.channels?.reef as { stateDir?: unknown } | undefined)?.stateDir;
    const keys = await loadKeys(runtime).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await assertLegacyReefKeysMigrated(
        typeof configuredStateDir === "string" ? configuredStateDir : undefined,
      );
      return await generateAndStoreKeys(runtime);
    });
    const client = new ReefTransportClient(relayUrl, handle, keys);
    let token: string | undefined;
    if (!setupSession) {
      const started = await client.authStart(email);
      if (started.magicLink) {
        await prompter.note(started.magicLink, "Development magic link");
      }
      token = await prompter.text({ message: "Magic-link token", sensitive: true });
    }
    // Reserve the keys immediately before consuming auth or claiming a handle.
    // Definitive relay rejection releases it; ambiguous transport failure keeps
    // the binding because the relay may have committed the request.
    const reservation = reserveReefIdentityBinding(runtime, { handle, relayUrl });
    let effectiveRequestPolicy = requestPolicy;
    try {
      if (!setupSession) {
        setupSession = (await client.authComplete(token ?? "")).session;
      }
      try {
        await client.createHandle(setupSession, requestPolicy);
      } catch (error) {
        const unavailable = error instanceof Error && error.message.includes("handle_unavailable");
        if (!unavailable) {
          throw error;
        }
        try {
          await client.listFriends();
        } catch (verificationError) {
          if (isReefOwnershipRejection(verificationError)) {
            releaseReefIdentityReservation(runtime, reservation);
            throw error;
          }
          finalizeReefIdentityBinding(runtime, reservation);
          throw verificationError;
        }
        // Signed access proves these keys already own the handle. Finalize
        // before checking account ownership so an account mismatch cannot
        // redirect the same keys to a different handle.
        finalizeReefIdentityBinding(runtime, reservation);
        const { handles } = await client.listOwnHandles(setupSession);
        const existing = handles.find((entry) => entry.handle === handle);
        if (!existing) {
          throw new Error(
            `Handle @${handle} is owned by this claw's keys, but the setup session belongs to a different relay account`,
            { cause: error },
          );
        }
        effectiveRequestPolicy = ReefChannelConfigSchema.shape.requestPolicy.parse(
          existing.request_policy,
        );
      }
      finalizeReefIdentityBinding(runtime, reservation);
    } catch (error) {
      if (isDefinitiveReefRegistrationFailure(error)) {
        releaseReefIdentityReservation(runtime, reservation);
      } else {
        finalizeReefIdentityBinding(runtime, reservation);
      }
      throw error;
    }
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
      requestPolicy: effectiveRequestPolicy,
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
