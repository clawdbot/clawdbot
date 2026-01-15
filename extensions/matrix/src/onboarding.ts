import { addWildcardAllowFrom } from "../../../src/channels/plugins/onboarding/helpers.js";
import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../../../src/channels/plugins/onboarding-types.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { ensureMatrixSdkInstalled, isMatrixSdkAvailable } from "./matrix/deps.js";
import type { CoreConfig, DmPolicy } from "./types.js";

const channel = "matrix" as const;

function setMatrixDmPolicy(cfg: CoreConfig, policy: DmPolicy) {
  const allowFrom = policy === "open" ? addWildcardAllowFrom(cfg.channels?.matrix?.dm?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.matrix,
        dm: {
          ...cfg.channels?.matrix?.dm,
          policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

async function noteMatrixAuthHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Matrix requires a homeserver URL + user ID.",
      "Use an access token or a password (password logs in and stores a token).",
      "Env vars supported: MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN, MATRIX_PASSWORD.",
      `Docs: ${formatDocsLink("/channels/matrix", "channels/matrix")}`,
    ].join("\n"),
    "Matrix setup",
  );
}

async function promptMatrixAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
}): Promise<CoreConfig> {
  const { cfg, prompter } = params;
  const existingAllowFrom = cfg.channels?.matrix?.dm?.allowFrom ?? [];
  const entry = await prompter.text({
    message: "Matrix allowFrom (user id)",
    placeholder: "@user:server",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Required";
      if (!raw.startsWith("@")) return "Matrix user IDs should start with @";
      if (!raw.includes(":")) return "Matrix user IDs should include a server (:@server)";
      return undefined;
    },
  });
  const normalized = String(entry).trim();
  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    normalized,
  ];
  const unique = [...new Set(merged)];

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.matrix,
        enabled: true,
        dm: {
          ...cfg.channels?.matrix?.dm,
          policy: "allowlist",
          allowFrom: unique,
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Matrix",
  channel,
  policyKey: "channels.matrix.dm.policy",
  allowFromKey: "channels.matrix.dm.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.matrix?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setMatrixDmPolicy(cfg as CoreConfig, policy),
};

export const matrixOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const account = resolveMatrixAccount({ cfg: cfg as CoreConfig });
    const configured = account.configured;
    const sdkReady = isMatrixSdkAvailable();
    return {
      channel,
      configured,
      statusLines: [`Matrix: ${configured ? "configured" : "needs homeserver + user id"}`],
      selectionHint: !sdkReady
        ? "install matrix-js-sdk"
        : configured
          ? "configured"
          : "needs auth",
    };
  },
  configure: async ({ cfg, runtime, prompter, forceAllowFrom }) => {
    let next = cfg as CoreConfig;
    await ensureMatrixSdkInstalled({
      runtime,
      confirm: async (message) =>
        await prompter.confirm({
          message,
          initialValue: true,
        }),
    });
    const existing = next.channels?.matrix ?? {};
    const account = resolveMatrixAccount({ cfg: next });
    if (!account.configured) {
      await noteMatrixAuthHelp(prompter);
    }

    const envHomeserver = process.env.MATRIX_HOMESERVER?.trim();
    const envUserId = process.env.MATRIX_USER_ID?.trim();
    const envAccessToken = process.env.MATRIX_ACCESS_TOKEN?.trim();
    const envPassword = process.env.MATRIX_PASSWORD?.trim();
    const envReady = Boolean(envHomeserver && envUserId && (envAccessToken || envPassword));

    if (
      envReady &&
      !existing.homeserver &&
      !existing.userId &&
      !existing.accessToken &&
      !existing.password
    ) {
      const useEnv = await prompter.confirm({
        message: "Matrix env vars detected. Use env values?",
        initialValue: true,
      });
      if (useEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            matrix: {
              ...next.channels?.matrix,
              enabled: true,
            },
          },
        };
        if (forceAllowFrom) {
          next = await promptMatrixAllowFrom({ cfg: next, prompter });
        }
        return { cfg: next };
      }
    }

    const homeserver = String(
      await prompter.text({
        message: "Matrix homeserver URL",
        initialValue: existing.homeserver ?? envHomeserver,
        validate: (value) => {
          const raw = String(value ?? "").trim();
          if (!raw) return "Required";
          if (!/^https?:\/\//i.test(raw)) return "Use a full URL (https://...)";
          return undefined;
        },
      }),
    ).trim();

    const userId = String(
      await prompter.text({
        message: "Matrix user ID",
        initialValue: existing.userId ?? envUserId,
        validate: (value) => {
          const raw = String(value ?? "").trim();
          if (!raw) return "Required";
          if (!raw.startsWith("@")) return "Matrix user IDs should start with @";
          if (!raw.includes(":")) return "Matrix user IDs should include a server (:@server)";
          return undefined;
        },
      }),
    ).trim();

    let accessToken = existing.accessToken ?? "";
    let password = existing.password ?? "";

    if (accessToken || password) {
      const keep = await prompter.confirm({
        message: "Matrix credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        accessToken = "";
        password = "";
      }
    }

    if (!accessToken && !password) {
      const authMode = (await prompter.select({
        message: "Matrix auth method",
        options: [
          { value: "token", label: "Access token" },
          { value: "password", label: "Password (stores token)" },
        ],
      })) as "token" | "password";

      if (authMode === "token") {
        accessToken = String(
          await prompter.text({
            message: "Matrix access token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      } else {
        password = String(
          await prompter.text({
            message: "Matrix password",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    }

    const deviceName = String(
      await prompter.text({
        message: "Matrix device name (optional)",
        initialValue: existing.deviceName ?? "Clawdbot Gateway",
      }),
    ).trim();

    next = {
      ...next,
      channels: {
        ...next.channels,
        matrix: {
          ...next.channels?.matrix,
          enabled: true,
          homeserver,
          userId,
          accessToken: accessToken || undefined,
          password: password || undefined,
          deviceName: deviceName || undefined,
        },
      },
    };

    if (forceAllowFrom) {
      next = await promptMatrixAllowFrom({ cfg: next, prompter });
    }

    return { cfg: next };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      matrix: { ...(cfg as CoreConfig).channels?.matrix, enabled: false },
    },
  }),
};
