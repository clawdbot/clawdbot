import type { Command } from "commander";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import * as cli from "./cli-shared.js";
import { resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { listMatrixOwnDevices } from "./matrix/actions/devices.js";
import { updateMatrixOwnProfile } from "./matrix/actions/profile.js";
import { resolveMatrixConfigPath, updateMatrixAccountConfig } from "./matrix/config-update.js";
import { isOpenClawManagedMatrixDevice } from "./matrix/device-health.js";
import { getMatrixRuntime } from "./runtime.js";
import type { MatrixSetupInput } from "./setup-config.js";
import { matrixSetupAdapter } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

type MatrixCliAccountAddResult = {
  accountId: string;
  configPath: string;
  useEnv: boolean;
  encryptionEnabled: boolean;
  deviceHealth: {
    currentDeviceId: string | null;
    staleOpenClawDeviceIds: string[];
    error?: string;
  };
  verificationBootstrap: {
    attempted: boolean;
    success: boolean;
    recoveryKeyCreatedAt: string | null;
    backupVersion: string | null;
    error?: string;
  };
  profile: {
    attempted: boolean;
    displayNameUpdated: boolean;
    avatarUpdated: boolean;
    resolvedAvatarUrl: string | null;
    convertedAvatarFromHttp: boolean;
    error?: string;
  };
};

async function addMatrixAccount(params: {
  account?: string;
  name?: string;
  avatarUrl?: string;
  homeserver?: string;
  proxy?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  initialSyncLimit?: string;
  allowPrivateNetwork?: boolean;
  useEnv?: boolean;
  enableEncryption?: boolean;
}): Promise<MatrixCliAccountAddResult> {
  const initialSyncLimit = cli.parseOptionalInt(params.initialSyncLimit, "--initial-sync-limit", {
    min: 0,
  });
  const runtime = getMatrixRuntime();
  const cfg = runtime.config.current() as CoreConfig;
  if (!matrixSetupAdapter.applyAccountConfig) {
    throw new Error("Matrix account setup is unavailable.");
  }

  const input: MatrixSetupInput = {
    name: params.name,
    avatarUrl: params.avatarUrl,
    homeserver: params.homeserver,
    dangerouslyAllowPrivateNetwork: params.allowPrivateNetwork,
    proxy: params.proxy,
    userId: params.userId,
    accessToken: params.accessToken,
    password: params.password,
    deviceName: params.deviceName,
    initialSyncLimit,
    useEnv: params.useEnv === true,
  };
  const accountId =
    matrixSetupAdapter.resolveAccountId?.({
      cfg,
      accountId: params.account,
      input,
    }) ?? normalizeAccountId(params.account?.trim() || params.name?.trim());
  const validationError = matrixSetupAdapter.validateInput?.({
    cfg,
    accountId,
    input,
  });
  if (validationError) {
    throw new Error(validationError);
  }
  const publishConfig = cli.createMatrixCliAccountConfigPublisher({ accountId, previousCfg: cfg });

  const applyAccountConfig = (current: CoreConfig): CoreConfig => {
    const next = matrixSetupAdapter.applyAccountConfig({ cfg: current, accountId, input });
    return params.enableEncryption === true
      ? updateMatrixAccountConfig(next, accountId, { encryption: true })
      : next;
  };
  let updated = applyAccountConfig(cfg);
  let convertedAvatarUrl: string | undefined;
  const accountConfig = resolveMatrixAccountConfig({ cfg: updated, accountId });

  try {
    let verificationBootstrap: MatrixCliAccountAddResult["verificationBootstrap"] = {
      attempted: false,
      success: false,
      recoveryKeyCreatedAt: null,
      backupVersion: null,
    };
    if (accountConfig.encryption === true) {
      const { maybeBootstrapNewEncryptedMatrixAccount } = await import("./setup-bootstrap.js");
      verificationBootstrap = await maybeBootstrapNewEncryptedMatrixAccount({
        previousCfg: cfg,
        cfg: updated,
        accountId,
      });
    }

    const desiredDisplayName = input.name?.trim();
    const desiredAvatarUrl = input.avatarUrl?.trim();
    let profile: MatrixCliAccountAddResult["profile"] = {
      attempted: false,
      displayNameUpdated: false,
      avatarUpdated: false,
      resolvedAvatarUrl: null,
      convertedAvatarFromHttp: false,
    };
    if (desiredDisplayName || desiredAvatarUrl) {
      try {
        const synced = await updateMatrixOwnProfile({
          cfg: updated,
          accountId,
          displayName: desiredDisplayName,
          avatarUrl: desiredAvatarUrl,
        });
        if (synced.convertedAvatarFromHttp && synced.resolvedAvatarUrl) {
          convertedAvatarUrl = synced.resolvedAvatarUrl;
          updated = updateMatrixAccountConfig(updated, accountId, {
            avatarUrl: synced.resolvedAvatarUrl,
          });
        }
        profile = {
          attempted: true,
          displayNameUpdated: synced.displayNameUpdated,
          avatarUpdated: synced.avatarUpdated,
          resolvedAvatarUrl: synced.resolvedAvatarUrl,
          convertedAvatarFromHttp: synced.convertedAvatarFromHttp,
        };
      } catch (err) {
        profile = {
          attempted: true,
          displayNameUpdated: false,
          avatarUpdated: false,
          resolvedAvatarUrl: null,
          convertedAvatarFromHttp: false,
          error: formatErrorMessage(err),
        };
      }
    }

    let deviceHealth: MatrixCliAccountAddResult["deviceHealth"];
    try {
      const addedDevices = await listMatrixOwnDevices({ accountId, cfg: updated });
      deviceHealth = {
        currentDeviceId: addedDevices.find((device) => device.current)?.deviceId ?? null,
        staleOpenClawDeviceIds: addedDevices
          .filter((device) => !device.current && isOpenClawManagedMatrixDevice(device.displayName))
          .map((device) => device.deviceId),
      };
    } catch (err) {
      deviceHealth = {
        currentDeviceId: null,
        staleOpenClawDeviceIds: [],
        error: formatErrorMessage(err),
      };
    }

    return {
      accountId,
      configPath: resolveMatrixConfigPath(updated, accountId),
      useEnv: input.useEnv === true,
      encryptionEnabled: accountConfig.encryption === true,
      deviceHealth,
      verificationBootstrap,
      profile,
    };
  } finally {
    // Gateway reload must not start a competing crypto client before setup retires.
    await publishConfig((current) => {
      const next = applyAccountConfig(current);
      return convertedAvatarUrl
        ? updateMatrixAccountConfig(next, accountId, { avatarUrl: convertedAvatarUrl })
        : next;
    });
  }
}

export function registerMatrixAccountCommands(root: Command): void {
  const account = root.command("account").description("Manage matrix channel accounts");

  account
    .command("add")
    .description("Add or update a matrix account (wrapper around channel setup)")
    .option("--account <id>", "Account ID (default: normalized --name, else default)")
    .option("--name <name>", "Optional display name for this account")
    .option("--avatar-url <url>", "Optional Matrix avatar URL (mxc:// or http(s) URL)")
    .option("--homeserver <url>", "Matrix homeserver URL")
    .option("--proxy <url>", "Optional HTTP(S) proxy URL for Matrix requests")
    .option(
      "--allow-private-network",
      "Allow Matrix homeserver traffic to private/internal hosts for this account",
    )
    .option("--user-id <id>", "Matrix user ID")
    .option("--access-token <token>", "Matrix access token")
    .option("--password <password>", "Matrix password")
    .option("--device-name <name>", "Matrix device display name")
    .option("--initial-sync-limit <n>", "Matrix initial sync limit")
    .option("--enable-e2ee", "Enable Matrix end-to-end encryption and bootstrap verification")
    .option("--encryption", "Alias for --enable-e2ee")
    .option(
      "--use-env",
      "Use MATRIX_* env vars (or MATRIX_<ACCOUNT_ID>_* for non-default accounts)",
    )
    .option("--verbose", "Show setup details")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        name?: string;
        avatarUrl?: string;
        homeserver?: string;
        proxy?: string;
        allowPrivateNetwork?: boolean;
        userId?: string;
        accessToken?: string;
        password?: string;
        deviceName?: string;
        initialSyncLimit?: string;
        enableE2ee?: boolean;
        encryption?: boolean;
        useEnv?: boolean;
        verbose?: boolean;
        json?: boolean;
      }) => {
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await addMatrixAccount({
              account: options.account,
              name: options.name,
              avatarUrl: options.avatarUrl,
              homeserver: options.homeserver,
              proxy: options.proxy,
              allowPrivateNetwork: options.allowPrivateNetwork === true,
              userId: options.userId,
              accessToken: options.accessToken,
              password: options.password,
              deviceName: options.deviceName,
              initialSyncLimit: options.initialSyncLimit,
              enableEncryption: options.enableE2ee === true || options.encryption === true,
              useEnv: options.useEnv === true,
            }),
          onText: (result) => {
            console.log(`Saved matrix account: ${cli.formatMatrixCliText(result.accountId)}`);
            console.log(`Config path: ${cli.formatMatrixCliText(result.configPath)}`);
            console.log(
              `Credentials source: ${result.useEnv ? "MATRIX_* / MATRIX_<ACCOUNT_ID>_* env vars" : "inline config"}`,
            );
            console.log(`Encryption: ${result.encryptionEnabled ? "enabled" : "disabled"}`);
            if (result.verificationBootstrap.attempted) {
              if (result.verificationBootstrap.success) {
                console.log("Matrix verification bootstrap: complete");
                cli.printTimestamp(
                  "Recovery key created at",
                  result.verificationBootstrap.recoveryKeyCreatedAt,
                );
                if (result.verificationBootstrap.backupVersion) {
                  console.log(
                    `Backup version: ${cli.formatMatrixCliText(result.verificationBootstrap.backupVersion)}`,
                  );
                }
              } else {
                console.error(
                  `Matrix verification bootstrap warning: ${cli.formatMatrixCliText(result.verificationBootstrap.error)}`,
                );
              }
            }
            if (result.deviceHealth.error) {
              console.error(
                `Matrix device health warning: ${cli.formatMatrixCliText(result.deviceHealth.error)}`,
              );
            } else if (result.deviceHealth.staleOpenClawDeviceIds.length > 0) {
              const staleDeviceIds = result.deviceHealth.staleOpenClawDeviceIds
                .map((deviceId) => cli.formatMatrixCliText(deviceId))
                .join(", ");
              console.log(
                `Matrix device hygiene warning: stale OpenClaw devices detected (${staleDeviceIds}). Run ${cli.formatMatrixCliCommand("devices prune-stale", result.accountId)}.`,
              );
            }
            if (result.profile.attempted) {
              if (result.profile.error) {
                console.error(
                  `Profile sync warning: ${cli.formatMatrixCliText(result.profile.error)}`,
                );
              } else {
                console.log(
                  `Profile sync: name ${result.profile.displayNameUpdated ? "updated" : "unchanged"}, avatar ${result.profile.avatarUpdated ? "updated" : "unchanged"}`,
                );
                if (result.profile.convertedAvatarFromHttp && result.profile.resolvedAvatarUrl) {
                  console.log(
                    `Avatar converted and saved as: ${cli.formatMatrixCliText(result.profile.resolvedAvatarUrl)}`,
                  );
                }
              }
            }
            const bindHint = `openclaw agents bind --agent <id> --bind matrix:${result.accountId}`;
            console.log(`Bind this account to an agent: ${bindHint}`);
          },
          errorPrefix: "Account setup failed",
        });
      },
    );
}
