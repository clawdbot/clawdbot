import { randomUUID } from "node:crypto";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { danger, info, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { logInfo } from "openclaw/plugin-sdk/text-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import {
  closeWaSocket,
  waitForWhatsAppLoginResult,
  WHATSAPP_LOGGED_OUT_QR_MESSAGE,
} from "./connection-controller.js";
import { renderQrPngBase64 } from "./qr-image.js";
import {
  createWaSocket,
  readWebAuthExistsForDecision,
  readWebSelfId,
  WHATSAPP_AUTH_UNSTABLE_CODE,
} from "./session.js";

type WaSocket = Awaited<ReturnType<typeof createWaSocket>>;
export type StartWebLoginWithQrResult = {
  qrDataUrl?: string;
  message: string;
  connected?: boolean;
  code?: typeof WHATSAPP_AUTH_UNSTABLE_CODE;
};

type ActiveLogin = {
  accountId: string;
  authDir: string;
  isLegacyAuthDir: boolean;
  id: string;
  sock: WaSocket;
  startedAt: number;
  qr?: string;
  qrDataUrl?: string;
  connected: boolean;
  error?: string;
  errorStatus?: number;
  waitPromise: Promise<void>;
  verbose: boolean;
  runtime: RuntimeEnv;
};

type LoginQrRaceResult =
  | { outcome: "qr"; qr: string }
  | { outcome: "connected" }
  | { outcome: "failed"; message: string };

function waitForNextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const ACTIVE_LOGIN_TTL_MS = 3 * 60_000;
const activeLogins = new Map<string, ActiveLogin>();

function closeSocket(sock: WaSocket) {
  closeWaSocket(sock);
}

async function resetActiveLogin(accountId: string, reason?: string) {
  const login = activeLogins.get(accountId);
  if (login) {
    closeSocket(login.sock);
    activeLogins.delete(accountId);
  }
  if (reason) {
    logInfo(reason);
  }
}

function isLoginFresh(login: ActiveLogin) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function attachLoginWaiter(accountId: string, login: ActiveLogin) {
  login.waitPromise = waitForWhatsAppLoginResult({
    sock: login.sock,
    authDir: login.authDir,
    isLegacyAuthDir: login.isLegacyAuthDir,
    verbose: login.verbose,
    runtime: login.runtime,
    onSocketReplaced: (sock) => {
      const current = activeLogins.get(accountId);
      if (current?.id === login.id) {
        current.sock = sock;
        current.connected = false;
        current.error = undefined;
        current.errorStatus = undefined;
      }
    },
  })
    .then((result) => {
      const current = activeLogins.get(accountId);
      if (current?.id !== login.id) {
        return;
      }
      if (result.outcome === "connected") {
        current.sock = result.sock;
        current.connected = true;
        return;
      }
      current.error = result.message;
      current.errorStatus = result.statusCode;
    })
    .catch((err) => {
      const current = activeLogins.get(accountId);
      if (current?.id !== login.id) {
        return;
      }
      current.error = err instanceof Error ? err.message : String(err);
      current.errorStatus = undefined;
    });
}

async function waitForQrOrRecoveredLogin(params: {
  accountId: string;
  login: ActiveLogin;
  qrPromise: Promise<string>;
}): Promise<LoginQrRaceResult> {
  const qrResult = params.qrPromise.then(
    (qr) => ({ outcome: "qr", qr }) as const,
    (err) =>
      ({
        outcome: "failed",
        message: `Failed to get QR: ${String(err)}`,
      }) as const,
  );
  const loginResult = params.login.waitPromise.then(async () => {
    const current = activeLogins.get(params.accountId);
    if (current?.id !== params.login.id) {
      return {
        outcome: "failed",
        message: "WhatsApp login was replaced by a newer request.",
      } as const;
    }

    // A QR may already be queued for the next task even if the login waiter won first.
    await waitForNextTask();
    const latest = activeLogins.get(params.accountId);
    if (latest?.id !== params.login.id) {
      return {
        outcome: "failed",
        message: "WhatsApp login was replaced by a newer request.",
      } as const;
    }
    if (latest.qr) {
      return { outcome: "qr", qr: latest.qr } as const;
    }
    if (latest.connected) {
      return { outcome: "connected" } as const;
    }
    return {
      outcome: "failed",
      message: latest.error ? `WhatsApp login failed: ${latest.error}` : "WhatsApp login failed.",
    } as const;
  });

  return await Promise.race([qrResult, loginResult]);
}

export async function startWebLoginWithQr(
  opts: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
    runtime?: RuntimeEnv;
  } = {},
): Promise<StartWebLoginWithQrResult> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const authState = await readWebAuthExistsForDecision(account.authDir);
  if (authState.outcome === "unstable") {
    return {
      code: WHATSAPP_AUTH_UNSTABLE_CODE,
      message: "WhatsApp auth state is still stabilizing. Retry login in a moment.",
    };
  }
  if (authState.exists && !opts.force) {
    const selfId = readWebSelfId(account.authDir);
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    return {
      message: `WhatsApp is already linked (${who}). Say “relink” if you want a fresh QR.`,
    };
  }

  const existing = activeLogins.get(account.accountId);
  if (existing && isLoginFresh(existing) && existing.qrDataUrl) {
    return {
      qrDataUrl: existing.qrDataUrl,
      message: "QR already active. Scan it in WhatsApp → Linked Devices.",
    };
  }

  await resetActiveLogin(account.accountId);

  let resolveQr: ((qr: string) => void) | null = null;
  let rejectQr: ((err: Error) => void) | null = null;
  const qrPromise = new Promise<string>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  const qrTimer = setTimeout(
    () => {
      rejectQr?.(new Error("Timed out waiting for WhatsApp QR"));
    },
    Math.max(opts.timeoutMs ?? 30_000, 5000),
  );

  let sock: WaSocket;
  let pendingQr: string | null = null;
  try {
    sock = await createWaSocket(false, Boolean(opts.verbose), {
      authDir: account.authDir,
      onQr: (qr: string) => {
        if (pendingQr) {
          return;
        }
        pendingQr = qr;
        const current = activeLogins.get(account.accountId);
        if (current && !current.qr) {
          current.qr = qr;
        }
        clearTimeout(qrTimer);
        runtime.log(info("WhatsApp QR received."));
        resolveQr?.(qr);
      },
    });
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to start WhatsApp login: ${String(err)}`,
    };
  }
  const login: ActiveLogin = {
    accountId: account.accountId,
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    id: randomUUID(),
    sock,
    startedAt: Date.now(),
    connected: false,
    waitPromise: Promise.resolve(),
    verbose: Boolean(opts.verbose),
    runtime,
  };
  activeLogins.set(account.accountId, login);
  if (pendingQr && !login.qr) {
    login.qr = pendingQr;
  }
  attachLoginWaiter(account.accountId, login);

  const loginStartResult = await waitForQrOrRecoveredLogin({
    accountId: account.accountId,
    login,
    qrPromise,
  });
  clearTimeout(qrTimer);

  if (loginStartResult.outcome === "connected") {
    const selfId = readWebSelfId(account.authDir);
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    await resetActiveLogin(account.accountId);
    return {
      message: `WhatsApp recovered the existing linked session (${who}).`,
      connected: true,
    };
  }

  if (loginStartResult.outcome === "failed") {
    await resetActiveLogin(account.accountId);
    return {
      message: loginStartResult.message,
    };
  }

  const base64 = await renderQrPngBase64(loginStartResult.qr);
  login.qrDataUrl = `data:image/png;base64,${base64}`;
  return {
    qrDataUrl: login.qrDataUrl,
    message: "Scan this QR in WhatsApp → Linked Devices.",
  };
}

export async function waitForWebLogin(
  opts: { timeoutMs?: number; runtime?: RuntimeEnv; accountId?: string } = {},
): Promise<{ connected: boolean; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const activeLogin = activeLogins.get(account.accountId);
  if (!activeLogin) {
    return {
      connected: false,
      message: "No active WhatsApp login in progress.",
    };
  }

  const login = activeLogin;
  if (!isLoginFresh(login)) {
    await resetActiveLogin(account.accountId);
    return {
      connected: false,
      message: "The login QR expired. Ask me to generate a new one.",
    };
  }
  const timeoutMs = Math.max(opts.timeoutMs ?? 120_000, 1000);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        connected: false,
        message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
      };
    }
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), remaining),
    );
    const result = await Promise.race([login.waitPromise.then(() => "done"), timeout]);

    if (result === "timeout") {
      return {
        connected: false,
        message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
      };
    }

    if (login.error) {
      if (login.errorStatus === 401) {
        const message = WHATSAPP_LOGGED_OUT_QR_MESSAGE;
        await resetActiveLogin(account.accountId, message);
        runtime.log(danger(message));
        return { connected: false, message };
      }
      const message = `WhatsApp login failed: ${login.error}`;
      await resetActiveLogin(account.accountId, message);
      runtime.log(danger(message));
      return { connected: false, message };
    }

    if (login.connected) {
      const message = "✅ Linked! WhatsApp is ready.";
      runtime.log(success(message));
      await resetActiveLogin(account.accountId);
      return { connected: true, message };
    }

    return { connected: false, message: "Login ended without a connection." };
  }
}
