import {
  startWebLoginWithQr as startWebLoginWithQrImpl,
  waitForWebLogin as waitForWebLoginImpl,
} from "../login-qr-runtime.js";
import { getActiveWebListener as getActiveWebListenerImpl } from "./active-listener.js";
import {
  getWebAuthAgeMs as getWebAuthAgeMsImpl,
  logWebSelfId as logWebSelfIdImpl,
  logoutWeb as logoutWebImpl,
  readWebAuthSnapshot as readWebAuthSnapshotImpl,
  readWebAuthState as readWebAuthStateImpl,
  readWebAuthExistsBestEffort as readWebAuthExistsBestEffortImpl,
  readWebAuthExistsForDecision as readWebAuthExistsForDecisionImpl,
  readWebAuthSnapshotBestEffort as readWebAuthSnapshotBestEffortImpl,
  readWebSelfId as readWebSelfIdImpl,
  webAuthExists as webAuthExistsImpl,
} from "./auth-store.js";
import { monitorWebChannel as monitorWebChannelImpl } from "./auto-reply/monitor.js";
import { loginWeb as loginWebImpl } from "./login.js";
import { whatsappSetupWizard as whatsappSetupWizardImpl } from "./setup-surface.js";

type GetActiveWebListener = typeof import("./active-listener.js").getActiveWebListener;
type GetWebAuthAgeMs = typeof import("./auth-store.js").getWebAuthAgeMs;
type LogWebSelfId = typeof import("./auth-store.js").logWebSelfId;
type LogoutWeb = typeof import("./auth-store.js").logoutWeb;
type ReadWebAuthSnapshot = typeof import("./auth-store.js").readWebAuthSnapshot;
type ReadWebAuthState = typeof import("./auth-store.js").readWebAuthState;
type ReadWebAuthExistsBestEffort = typeof import("./auth-store.js").readWebAuthExistsBestEffort;
type ReadWebAuthExistsForDecision = typeof import("./auth-store.js").readWebAuthExistsForDecision;
type ReadWebAuthSnapshotBestEffort = typeof import("./auth-store.js").readWebAuthSnapshotBestEffort;
type ReadWebSelfId = typeof import("./auth-store.js").readWebSelfId;
type WebAuthExists = typeof import("./auth-store.js").webAuthExists;
type LoginWeb = typeof import("./login.js").loginWeb;
type StartWebLoginWithQr = typeof import("../login-qr-runtime.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("../login-qr-runtime.js").waitForWebLogin;
type WhatsAppSetupWizard = typeof import("./setup-surface.js").whatsappSetupWizard;
type MonitorWebChannel = typeof import("./auto-reply/monitor.js").monitorWebChannel;

export function getActiveWebListener(
  ...args: Parameters<GetActiveWebListener>
): ReturnType<GetActiveWebListener> {
  return getActiveWebListenerImpl(...args);
}

export function getWebAuthAgeMs(...args: Parameters<GetWebAuthAgeMs>): ReturnType<GetWebAuthAgeMs> {
  return getWebAuthAgeMsImpl(...args);
}

export function logWebSelfId(...args: Parameters<LogWebSelfId>): ReturnType<LogWebSelfId> {
  return logWebSelfIdImpl(...args);
}

export function logoutWeb(...args: Parameters<LogoutWeb>): ReturnType<LogoutWeb> {
  return logoutWebImpl(...args);
}

export function readWebAuthSnapshot(
  ...args: Parameters<ReadWebAuthSnapshot>
): ReturnType<ReadWebAuthSnapshot> {
  return readWebAuthSnapshotImpl(...args);
}

export function readWebAuthState(
  ...args: Parameters<ReadWebAuthState>
): ReturnType<ReadWebAuthState> {
  return readWebAuthStateImpl(...args);
}

export function readWebAuthExistsBestEffort(
  ...args: Parameters<ReadWebAuthExistsBestEffort>
): ReturnType<ReadWebAuthExistsBestEffort> {
  return readWebAuthExistsBestEffortImpl(...args);
}

export function readWebAuthExistsForDecision(
  ...args: Parameters<ReadWebAuthExistsForDecision>
): ReturnType<ReadWebAuthExistsForDecision> {
  return readWebAuthExistsForDecisionImpl(...args);
}

export function readWebAuthSnapshotBestEffort(
  ...args: Parameters<ReadWebAuthSnapshotBestEffort>
): ReturnType<ReadWebAuthSnapshotBestEffort> {
  return readWebAuthSnapshotBestEffortImpl(...args);
}

export function readWebSelfId(...args: Parameters<ReadWebSelfId>): ReturnType<ReadWebSelfId> {
  return readWebSelfIdImpl(...args);
}

export function webAuthExists(...args: Parameters<WebAuthExists>): ReturnType<WebAuthExists> {
  return webAuthExistsImpl(...args);
}

export function loginWeb(...args: Parameters<LoginWeb>): ReturnType<LoginWeb> {
  return loginWebImpl(...args);
}

export async function startWebLoginWithQr(
  ...args: Parameters<StartWebLoginWithQr>
): ReturnType<StartWebLoginWithQr> {
  return await startWebLoginWithQrImpl(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WaitForWebLogin>
): ReturnType<WaitForWebLogin> {
  return await waitForWebLoginImpl(...args);
}

export const whatsappSetupWizard: WhatsAppSetupWizard = { ...whatsappSetupWizardImpl };

export function monitorWebChannel(
  ...args: Parameters<MonitorWebChannel>
): ReturnType<MonitorWebChannel> {
  return monitorWebChannelImpl(...args);
}
