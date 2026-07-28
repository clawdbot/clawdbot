// Whatsapp plugin module implements login behavior.
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { logInfo } from "openclaw/plugin-sdk/logging-core";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount } from "./accounts.js";
import { restoreCredsFromBackupIfNeeded } from "./auth-store.js";
import { closeWaSocketSoon, waitForWhatsAppLoginResult } from "./connection-controller.js";
import { renderQrTerminal } from "./qr-terminal.js";
import { createWaSocket, waitForWaConnection } from "./session.js";
import { resolveWhatsAppSocketTiming } from "./socket-timing.js";

const QR_LINK_INSTRUCTION = "Open the WhatsApp app, go to Linked Devices, then scan this QR:";
const CLEAR_TERMINAL = "\x1b[2J\x1b[H";

type CredentialPersistenceFailure = { error: unknown };

export async function loginWeb(
  verbose: boolean,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
  options?: { beforeCredentialPersistence?: () => Promise<void> },
) {
  const cfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const socketTiming = resolveWhatsAppSocketTiming();
  const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir, {
    beforeCredentialPersistence: options?.beforeCredentialPersistence,
  });
  const credentialPersistenceState: { failure: CredentialPersistenceFailure | null } = {
    failure: null,
  };
  let resolveCredentialPersistenceFailure = (_failure: CredentialPersistenceFailure) => {};
  const credentialPersistenceFailurePromise = new Promise<CredentialPersistenceFailure>(
    (resolve) => {
      resolveCredentialPersistenceFailure = resolve;
    },
  );
  const onCredentialPersistenceError = (error: unknown) => {
    if (credentialPersistenceState.failure) {
      return;
    }
    credentialPersistenceState.failure = { error };
    resolveCredentialPersistenceFailure(credentialPersistenceState.failure);
  };
  const credentialPersistenceTasks = new Set<Promise<unknown>>();
  const onCredentialPersistenceTask = (task: Promise<unknown>) => {
    credentialPersistenceTasks.add(task);
    void task.then(
      () => credentialPersistenceTasks.delete(task),
      () => credentialPersistenceTasks.delete(task),
    );
  };
  const waitForCredentialPersistence = async () => {
    // Baileys schedules the final LID key write on nextTick after reporting open.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    while (credentialPersistenceTasks.size > 0) {
      await Promise.allSettled(credentialPersistenceTasks);
    }
  };
  const credentialPersistenceOptions = options?.beforeCredentialPersistence
    ? {
        beforeCredentialPersistence: async () => {
          try {
            await options.beforeCredentialPersistence?.();
          } catch (error) {
            onCredentialPersistenceError(error);
            throw error;
          }
        },
        onCredentialPersistenceError,
        onCredentialPersistenceTask,
      }
    : {};
  let qrVersion = 0;
  const onQr = (qr: string) => {
    const currentQrVersion = ++qrVersion;
    void renderQrTerminal(qr, { small: true })
      .then((output) => {
        if (currentQrVersion !== qrVersion) {
          return;
        }
        const refreshPrefix = currentQrVersion > 1 && process.stdout.isTTY ? CLEAR_TERMINAL : "";
        const renderedQr = output.endsWith("\n") ? output.slice(0, -1) : output;
        runtime.log(`${refreshPrefix}${QR_LINK_INSTRUCTION}\n${renderedQr}`);
      })
      .catch((err: unknown) => {
        if (currentQrVersion !== qrVersion) {
          return;
        }
        runtime.error(`failed rendering WhatsApp QR: ${String(err)}`);
      });
  };
  let sock = await createWaSocket(false, verbose, {
    authDir: account.authDir,
    ...socketTiming,
    onQr,
    ...credentialPersistenceOptions,
  });
  logInfo("Waiting for WhatsApp connection...", runtime);
  try {
    const result = await waitForWhatsAppLoginResult({
      sock,
      authDir: account.authDir,
      isLegacyAuthDir: account.isLegacyAuthDir,
      verbose,
      runtime,
      waitForConnection,
      socketTiming,
      onQr,
      ...credentialPersistenceOptions,
      ...(options?.beforeCredentialPersistence
        ? {
            credentialPersistenceFailure: credentialPersistenceFailurePromise,
            getCredentialPersistenceFailure: () => credentialPersistenceState.failure,
            waitForCredentialPersistence,
          }
        : {}),
      onSocketReplaced: (replacementSock) => {
        sock = replacementSock;
      },
    });
    if (credentialPersistenceState.failure) {
      throw credentialPersistenceState.failure.error;
    }
    if (result.outcome === "connected") {
      runtime.log(
        success(
          result.restarted
            ? "✅ Linked after restart; web session ready."
            : restoredFromBackup
              ? "✅ Recovered from creds.json.bak; web session ready."
              : "✅ Linked! Credentials saved for future sends.",
        ),
      );
      return;
    }

    if (result.outcome === "logged-out") {
      runtime.error(
        danger(
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`,
        ),
      );
      throw new Error("Session logged out; cache cleared. Re-run login.", {
        cause: result.error,
      });
    }

    runtime.error(danger(`WhatsApp Web connection ended before fully opening. ${result.message}`));
    throw new Error(result.message, { cause: result.error });
  } finally {
    // Let Baileys flush any final events before closing the socket.
    closeWaSocketSoon(sock);
  }
}
