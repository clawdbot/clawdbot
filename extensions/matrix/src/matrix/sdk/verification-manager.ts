import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { formatMatrixErrorMessage } from "../errors.js";

export type MatrixVerificationMethod = "sas" | "show-qr" | "scan-qr";
type MatrixVerificationPhase = VerificationPhase | -1;

const MATRIX_VERIFICATION_PHASES = new Set<MatrixVerificationPhase>([
  -1,
  VerificationPhase.Unsent,
  VerificationPhase.Requested,
  VerificationPhase.Ready,
  VerificationPhase.Started,
  VerificationPhase.Cancelled,
  VerificationPhase.Done,
]);

function isMatrixVerificationPhase(value: unknown): value is MatrixVerificationPhase {
  return (
    typeof value === "number" && MATRIX_VERIFICATION_PHASES.has(value as MatrixVerificationPhase)
  );
}

export type MatrixVerificationSummary = {
  id: string;
  transactionId?: string;
  roomId?: string;
  otherUserId: string;
  otherDeviceId?: string;
  isSelfVerification: boolean;
  initiatedByMe: boolean;
  phase: number;
  phaseName: string;
  pending: boolean;
  methods: string[];
  chosenMethod?: string | null;
  canAccept: boolean;
  hasSas: boolean;
  sas?: {
    decimal?: [number, number, number];
    emoji?: Array<[string, string]>;
  };
  hasReciprocateQr: boolean;
  completed: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type MatrixVerificationSummaryListener = (summary: MatrixVerificationSummary) => void;
type MatrixVerificationOwnerTrustCallback = (deviceId: string) => Promise<void>;

export type MatrixShowSasCallbacks = {
  sas: {
    decimal?: [number, number, number];
    emoji?: Array<[string, string]>;
  };
  confirm: () => Promise<void>;
  mismatch: () => void;
  cancel: () => void;
};

export type MatrixShowQrCodeCallbacks = {
  confirm: () => void;
  cancel: () => void;
};

export type MatrixVerifierLike = {
  verify: () => Promise<void>;
  cancel: (e: Error) => void;
  getShowSasCallbacks: () => MatrixShowSasCallbacks | null;
  getReciprocateQrCodeCallbacks: () => MatrixShowQrCodeCallbacks | null;
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
};

export type MatrixVerificationRequestLike = {
  transactionId?: string;
  roomId?: string;
  initiatedByMe: boolean;
  otherUserId: string;
  otherDeviceId?: string;
  isSelfVerification: boolean;
  phase: number;
  pending: boolean;
  accepting: boolean;
  declining: boolean;
  methods: string[];
  chosenMethod?: string | null;
  cancellationCode?: string | null;
  accept: () => Promise<void>;
  cancel: (params?: { reason?: string; code?: string }) => Promise<void>;
  startVerification: (method: string) => Promise<MatrixVerifierLike>;
  scanQRCode: (qrCodeData: Uint8ClampedArray) => Promise<MatrixVerifierLike>;
  generateQRCode: () => Promise<Uint8ClampedArray | undefined>;
  verifier?: MatrixVerifierLike;
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
};

export type MatrixVerificationCryptoApi = {
  requestOwnUserVerification: () => Promise<MatrixVerificationRequestLike | null>;
  getVerificationRequestsToDeviceInProgress?: (userId: string) => MatrixVerificationRequestLike[];
  findVerificationRequestDMInProgress?: (
    roomId: string,
    userId: string,
  ) => MatrixVerificationRequestLike | undefined;
  requestDeviceVerification?: (
    userId: string,
    deviceId: string,
  ) => Promise<MatrixVerificationRequestLike>;
  requestVerificationDM?: (
    userId: string,
    roomId: string,
  ) => Promise<MatrixVerificationRequestLike>;
};

type MatrixVerificationSession = {
  id: string;
  request: MatrixVerificationRequestLike;
  createdAtMs: number;
  updatedAtMs: number;
  error?: string;
  activeVerifier?: MatrixVerifierLike;
  verifyPromise?: Promise<void>;
  verifyStarted: boolean;
  startRequested: boolean;
  acceptRequested: boolean;
  sasAutoConfirmStarted: boolean;
  sasAutoConfirmTimer?: ReturnType<typeof setTimeout>;
  sasCallbacks?: MatrixShowSasCallbacks;
  reciprocateQrCallbacks?: MatrixShowQrCodeCallbacks;
};

type MatrixVerificationRequestIdentity = {
  transactionId: string;
  roomId: string;
  otherUserId: string;
  otherDeviceId: string;
  isSelfVerification: boolean;
  initiatedByMe: boolean;
};

const MAX_TRACKED_VERIFICATION_SESSIONS = 256;
const TERMINAL_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const SAS_AUTO_CONFIRM_DELAY_MS = 30_000;

export class MatrixVerificationManager {
  private readonly verificationSessions = new Map<string, MatrixVerificationSession>();
  private verificationSessionCounter = 0;
  private readonly trackedVerificationRequests = new WeakSet<object>();
  private readonly trackedVerificationVerifiers = new WeakSet<object>();
  private readonly summaryListeners = new Set<MatrixVerificationSummaryListener>();

  constructor(
    private readonly opts: {
      trustOwnDeviceAfterSas?: MatrixVerificationOwnerTrustCallback;
    } = {},
  ) {}

  private readRequestValue<T>(
    request: MatrixVerificationRequestLike,
    reader: () => T,
    fallback: T,
  ): T {
    try {
      return reader();
    } catch {
      return fallback;
    }
  }

  private readVerificationPhase(
    request: MatrixVerificationRequestLike,
    fallback: MatrixVerificationPhase,
  ): MatrixVerificationPhase {
    const phase = this.readRequestValue<unknown>(request, () => request.phase, fallback);
    return isMatrixVerificationPhase(phase) ? phase : fallback;
  }

  private readVerificationRequestIdentity(
    request: MatrixVerificationRequestLike,
  ): MatrixVerificationRequestIdentity {
    return {
      transactionId: this.readRequestValue(request, () => request.transactionId?.trim() ?? "", ""),
      roomId: this.readRequestValue(request, () => request.roomId ?? "", ""),
      otherUserId: this.readRequestValue(request, () => request.otherUserId, ""),
      otherDeviceId: this.readRequestValue(request, () => request.otherDeviceId ?? "", ""),
      isSelfVerification: this.readRequestValue(request, () => request.isSelfVerification, false),
      initiatedByMe: this.readRequestValue(request, () => request.initiatedByMe, false),
    };
  }

  private isSameLogicalVerificationRequest(
    left: MatrixVerificationRequestLike,
    right: MatrixVerificationRequestLike,
  ): boolean {
    const leftIdentity = this.readVerificationRequestIdentity(left);
    const rightIdentity = this.readVerificationRequestIdentity(right);
    return (
      leftIdentity.transactionId !== "" &&
      leftIdentity.transactionId === rightIdentity.transactionId &&
      leftIdentity.roomId === rightIdentity.roomId &&
      leftIdentity.otherUserId === rightIdentity.otherUserId &&
      this.isSameOptionalIdentityValue(leftIdentity.otherDeviceId, rightIdentity.otherDeviceId) &&
      leftIdentity.isSelfVerification === rightIdentity.isSelfVerification &&
      leftIdentity.initiatedByMe === rightIdentity.initiatedByMe
    );
  }

  private isSameOptionalIdentityValue(left: string, right: string): boolean {
    return left === "" || right === "" || left === right;
  }

  private pruneVerificationSessions(nowMs: number): void {
    for (const [id, session] of this.verificationSessions) {
      const phase = this.readVerificationPhase(session.request, -1);
      const isTerminal = phase === VerificationPhase.Done || phase === VerificationPhase.Cancelled;
      if (isTerminal && nowMs - session.updatedAtMs > TERMINAL_SESSION_RETENTION_MS) {
        this.verificationSessions.delete(id);
      }
    }

    if (this.verificationSessions.size <= MAX_TRACKED_VERIFICATION_SESSIONS) {
      return;
    }

    const sortedByAge = Array.from(this.verificationSessions.entries()).toSorted(
      (a, b) => a[1].updatedAtMs - b[1].updatedAtMs,
    );
    const overflow = this.verificationSessions.size - MAX_TRACKED_VERIFICATION_SESSIONS;
    for (let i = 0; i < overflow; i += 1) {
      const entry = sortedByAge[i];
      if (entry) {
        this.verificationSessions.delete(entry[0]);
      }
    }
  }

  private getVerificationPhaseName(phase: MatrixVerificationPhase): string {
    switch (phase) {
      case VerificationPhase.Unsent:
        return "unsent";
      case VerificationPhase.Requested:
        return "requested";
      case VerificationPhase.Ready:
        return "ready";
      case VerificationPhase.Started:
        return "started";
      case VerificationPhase.Cancelled:
        return "cancelled";
      case VerificationPhase.Done:
        return "done";
      default:
        return `unknown(${phase})`;
    }
  }

  private emitVerificationSummary(session: MatrixVerificationSession): void {
    const summary = this.buildVerificationSummary(session);
    for (const listener of this.summaryListeners) {
      listener(summary);
    }
  }

  private touchVerificationSession(session: MatrixVerificationSession): void {
    session.updatedAtMs = Date.now();
    this.emitVerificationSummary(session);
  }

  private clearSasAutoConfirmTimer(session: MatrixVerificationSession): void {
    if (!session.sasAutoConfirmTimer) {
      return;
    }
    clearTimeout(session.sasAutoConfirmTimer);
    session.sasAutoConfirmTimer = undefined;
  }

  private buildVerificationSummary(session: MatrixVerificationSession): MatrixVerificationSummary {
    const request = session.request;
    const phase = this.readVerificationPhase(request, VerificationPhase.Requested);
    const accepting = this.readRequestValue(request, () => request.accepting, false);
    const declining = this.readRequestValue(request, () => request.declining, false);
    const pending = this.readRequestValue(request, () => request.pending, false);
    const methodsRaw = this.readRequestValue<unknown>(request, () => request.methods, []);
    const methods = Array.isArray(methodsRaw)
      ? methodsRaw.filter((entry): entry is string => typeof entry === "string")
      : [];
    const sasCallbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
    if (sasCallbacks) {
      session.sasCallbacks = sasCallbacks;
    }
    const canAccept = phase < VerificationPhase.Ready && !accepting && !declining;
    return {
      id: session.id,
      transactionId: this.readRequestValue(request, () => request.transactionId, undefined),
      roomId: this.readRequestValue(request, () => request.roomId, undefined),
      otherUserId: this.readRequestValue(request, () => request.otherUserId, "unknown"),
      otherDeviceId: this.readRequestValue(request, () => request.otherDeviceId, undefined),
      isSelfVerification: this.readRequestValue(request, () => request.isSelfVerification, false),
      initiatedByMe: this.readRequestValue(request, () => request.initiatedByMe, false),
      phase,
      phaseName: this.getVerificationPhaseName(phase),
      pending,
      methods,
      chosenMethod: this.readRequestValue(request, () => request.chosenMethod ?? null, null),
      canAccept,
      hasSas: Boolean(sasCallbacks),
      sas: sasCallbacks
        ? {
            decimal: sasCallbacks.sas.decimal,
            emoji: sasCallbacks.sas.emoji,
          }
        : undefined,
      hasReciprocateQr: Boolean(session.reciprocateQrCallbacks),
      completed: phase === VerificationPhase.Done,
      error: session.error,
      createdAt: new Date(session.createdAtMs).toISOString(),
      updatedAt: new Date(session.updatedAtMs).toISOString(),
    };
  }

  private findVerificationSession(id: string): MatrixVerificationSession {
    const direct = this.verificationSessions.get(id);
    if (direct) {
      return direct;
    }
    const transactionMatches = Array.from(this.verificationSessions.values()).filter((session) => {
      const txId = this.readRequestValue(
        session.request,
        () => session.request.transactionId?.trim(),
        "",
      );
      return txId === id;
    });
    if (transactionMatches.length === 1) {
      return transactionMatches[0];
    }
    if (transactionMatches.length > 1) {
      throw new Error(
        `Matrix verification request id is ambiguous for transaction ${id}; use the verification id instead`,
      );
    }
    throw new Error(`Matrix verification request not found: ${id}`);
  }

  private ensureVerificationRequestTracked(session: MatrixVerificationSession): void {
    const requestObj = session.request as unknown as object;
    if (this.trackedVerificationRequests.has(requestObj)) {
      return;
    }
    this.trackedVerificationRequests.add(requestObj);
    session.request.on(VerificationRequestEvent.Change, () => {
      this.touchVerificationSession(session);
      this.maybeAutoAcceptInboundRequest(session);
      const verifier = this.readRequestValue(session.request, () => session.request.verifier, null);
      if (verifier) {
        this.attachVerifierToVerificationSession(session, verifier);
      }
      this.maybeAutoStartInboundSas(session);
    });
  }

  private maybeAutoAcceptInboundRequest(session: MatrixVerificationSession): void {
    if (session.acceptRequested) {
      return;
    }
    const request = session.request;
    const isSelfVerification = this.readRequestValue(
      request,
      () => request.isSelfVerification,
      false,
    );
    const initiatedByMe = this.readRequestValue(request, () => request.initiatedByMe, false);
    const phase = this.readVerificationPhase(request, VerificationPhase.Requested);
    const accepting = this.readRequestValue(request, () => request.accepting, false);
    const declining = this.readRequestValue(request, () => request.declining, false);
    if (isSelfVerification || initiatedByMe) {
      return;
    }
    if (phase !== VerificationPhase.Requested || accepting || declining) {
      return;
    }

    session.acceptRequested = true;
    void request
      .accept()
      .then(() => {
        this.touchVerificationSession(session);
      })
      .catch((err) => {
        session.acceptRequested = false;
        session.error = formatMatrixErrorMessage(err);
        this.touchVerificationSession(session);
      });
  }

  private maybeAutoStartInboundSas(session: MatrixVerificationSession): void {
    if (session.activeVerifier || session.verifyStarted || session.startRequested) {
      return;
    }
    if (this.readRequestValue(session.request, () => session.request.initiatedByMe, true)) {
      return;
    }
    if (!this.readRequestValue(session.request, () => session.request.isSelfVerification, false)) {
      return;
    }
    const phase = this.readVerificationPhase(session.request, VerificationPhase.Requested);
    if (phase < VerificationPhase.Ready || phase >= VerificationPhase.Cancelled) {
      return;
    }
    const methodsRaw = this.readRequestValue<unknown>(
      session.request,
      () => session.request.methods,
      [],
    );
    const methods = Array.isArray(methodsRaw)
      ? methodsRaw.filter((entry): entry is string => typeof entry === "string")
      : [];
    const chosenMethod = this.readRequestValue(
      session.request,
      () => session.request.chosenMethod,
      null,
    );
    const supportsSas =
      methods.includes(VerificationMethod.Sas) || chosenMethod === VerificationMethod.Sas;
    if (!supportsSas) {
      return;
    }

    session.startRequested = true;
    void session.request
      .startVerification(VerificationMethod.Sas)
      .then((verifier) => {
        this.attachVerifierToVerificationSession(session, verifier);
        this.touchVerificationSession(session);
      })
      .catch(() => {
        session.startRequested = false;
      });
  }

  private attachVerifierToVerificationSession(
    session: MatrixVerificationSession,
    verifier: MatrixVerifierLike,
  ): void {
    session.activeVerifier = verifier;
    this.touchVerificationSession(session);

    const maybeSas = verifier.getShowSasCallbacks();
    if (maybeSas) {
      session.sasCallbacks = maybeSas;
      this.maybeAutoConfirmSas(session);
    }
    const maybeReciprocateQr = verifier.getReciprocateQrCodeCallbacks();
    if (maybeReciprocateQr) {
      session.reciprocateQrCallbacks = maybeReciprocateQr;
    }

    const verifierObj = verifier as unknown as object;
    if (this.trackedVerificationVerifiers.has(verifierObj)) {
      this.ensureVerificationStarted(session);
      return;
    }
    this.trackedVerificationVerifiers.add(verifierObj);

    verifier.on(VerifierEvent.ShowSas, (sas) => {
      session.sasCallbacks = sas as MatrixShowSasCallbacks;
      this.touchVerificationSession(session);
      this.maybeAutoConfirmSas(session);
    });
    verifier.on(VerifierEvent.ShowReciprocateQr, (qr) => {
      session.reciprocateQrCallbacks = qr as MatrixShowQrCodeCallbacks;
      this.touchVerificationSession(session);
    });
    verifier.on(VerifierEvent.Cancel, (err) => {
      this.clearSasAutoConfirmTimer(session);
      session.error = formatMatrixErrorMessage(err);
      this.touchVerificationSession(session);
    });
    this.ensureVerificationStarted(session);
  }

  private maybeAutoConfirmSas(session: MatrixVerificationSession): void {
    if (session.sasAutoConfirmStarted || session.sasAutoConfirmTimer) {
      return;
    }
    if (this.readRequestValue(session.request, () => session.request.initiatedByMe, true)) {
      return;
    }
    const callbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
    if (!callbacks) {
      return;
    }
    session.sasCallbacks = callbacks;
    // Give the remote client a moment to surface the compare-emoji UI before
    // we send our MAC and finish our side of the SAS flow.
    session.sasAutoConfirmTimer = setTimeout(() => {
      session.sasAutoConfirmTimer = undefined;
      const phase = this.readVerificationPhase(session.request, VerificationPhase.Requested);
      if (phase >= VerificationPhase.Cancelled) {
        return;
      }
      session.sasAutoConfirmStarted = true;
      void this.confirmSasForSession(session, callbacks, { trustOwnDevice: false })
        .then(() => {
          this.touchVerificationSession(session);
        })
        .catch((err) => {
          session.error = formatMatrixErrorMessage(err);
          this.touchVerificationSession(session);
        });
    }, SAS_AUTO_CONFIRM_DELAY_MS);
  }

  private async confirmSasForSession(
    session: MatrixVerificationSession,
    callbacks: MatrixShowSasCallbacks,
    opts: { trustOwnDevice: boolean } = { trustOwnDevice: true },
  ): Promise<void> {
    await callbacks.confirm();
    if (opts.trustOwnDevice) {
      await this.trustOwnDeviceAfterConfirmedSas(session);
    }
  }

  private ensureVerificationStarted(session: MatrixVerificationSession): void {
    if (!session.activeVerifier || session.verifyStarted) {
      return;
    }
    session.verifyStarted = true;
    const verifier = session.activeVerifier;
    session.verifyPromise = verifier
      .verify()
      .then(() => {
        this.touchVerificationSession(session);
      })
      .catch((err) => {
        session.error = formatMatrixErrorMessage(err);
        this.touchVerificationSession(session);
      });
  }

  private async trustOwnDeviceAfterConfirmedSas(session: MatrixVerificationSession): Promise<void> {
    if (!this.readRequestValue(session.request, () => session.request.isSelfVerification, false)) {
      return;
    }
    const deviceId = this.readRequestValue(
      session.request,
      () => session.request.otherDeviceId?.trim(),
      "",
    );
    if (!deviceId || !this.opts.trustOwnDeviceAfterSas) {
      return;
    }
    await this.opts.trustOwnDeviceAfterSas(deviceId);
  }

  onSummaryChanged(listener: MatrixVerificationSummaryListener): () => void {
    this.summaryListeners.add(listener);
    return () => {
      this.summaryListeners.delete(listener);
    };
  }

  trackVerificationRequest(request: MatrixVerificationRequestLike): MatrixVerificationSummary {
    this.pruneVerificationSessions(Date.now());
    const requestObj = request as unknown as object;
    for (const existing of this.verificationSessions.values()) {
      if ((existing.request as unknown as object) === requestObj) {
        this.touchVerificationSession(existing);
        return this.buildVerificationSummary(existing);
      }
    }
    const txId = this.readVerificationRequestIdentity(request).transactionId;
    if (txId) {
      for (const existing of this.verificationSessions.values()) {
        if (this.isSameLogicalVerificationRequest(existing.request, request)) {
          existing.request = request;
          this.ensureVerificationRequestTracked(existing);
          const verifier = this.readRequestValue(request, () => request.verifier, null);
          if (verifier) {
            this.attachVerifierToVerificationSession(existing, verifier);
          }
          this.touchVerificationSession(existing);
          return this.buildVerificationSummary(existing);
        }
      }
    }

    const now = Date.now();
    const id = `verification-${++this.verificationSessionCounter}`;
    const session: MatrixVerificationSession = {
      id,
      request,
      createdAtMs: now,
      updatedAtMs: now,
      verifyStarted: false,
      startRequested: false,
      acceptRequested: false,
      sasAutoConfirmStarted: false,
    };
    this.verificationSessions.set(session.id, session);
    this.ensureVerificationRequestTracked(session);
    this.maybeAutoAcceptInboundRequest(session);
    const verifier = this.readRequestValue(request, () => request.verifier, null);
    if (verifier) {
      this.attachVerifierToVerificationSession(session, verifier);
    }
    this.maybeAutoStartInboundSas(session);
    this.emitVerificationSummary(session);
    return this.buildVerificationSummary(session);
  }

  async requestOwnUserVerification(
    crypto: MatrixVerificationCryptoApi | undefined,
  ): Promise<MatrixVerificationSummary | null> {
    if (!crypto) {
      return null;
    }
    const request = await crypto.requestOwnUserVerification();
    if (!request) {
      return null;
    }
    return this.trackVerificationRequest(request);
  }

  listVerifications(): MatrixVerificationSummary[] {
    this.pruneVerificationSessions(Date.now());
    const summaries = Array.from(this.verificationSessions.values()).map((session) =>
      this.buildVerificationSummary(session),
    );
    return summaries.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async requestVerification(
    crypto: MatrixVerificationCryptoApi | undefined,
    params: {
      ownUser?: boolean;
      userId?: string;
      deviceId?: string;
      roomId?: string;
    },
  ): Promise<MatrixVerificationSummary> {
    if (!crypto) {
      throw new Error("Matrix crypto is not available");
    }
    let request: MatrixVerificationRequestLike | null = null;
    if (params.ownUser) {
      request = await crypto.requestOwnUserVerification();
    } else if (params.userId && params.deviceId && crypto.requestDeviceVerification) {
      request = await crypto.requestDeviceVerification(params.userId, params.deviceId);
    } else if (params.userId && params.roomId && crypto.requestVerificationDM) {
      request = await crypto.requestVerificationDM(params.userId, params.roomId);
    } else {
      throw new Error(
        "Matrix verification request requires one of: ownUser, userId+deviceId, or userId+roomId",
      );
    }

    if (!request) {
      throw new Error("Matrix verification request could not be created");
    }
    return this.trackVerificationRequest(request);
  }

  async acceptVerification(id: string): Promise<MatrixVerificationSummary> {
    const session = this.findVerificationSession(id);
    await session.request.accept();
    this.touchVerificationSession(session);
    return this.buildVerificationSummary(session);
  }

  async cancelVerification(
    id: string,
    params?: { reason?: string; code?: string },
  ): Promise<MatrixVerificationSummary> {
    const session = this.findVerificationSession(id);
    await session.request.cancel(params);
    this.touchVerificationSession(session);
    return this.buildVerificationSummary(session);
  }

  async startVerification(
    id: string,
    method: MatrixVerificationMethod = "sas",
  ): Promise<MatrixVerificationSummary> {
    const session = this.findVerificationSession(id);
    if (method !== "sas") {
      throw new Error("Matrix startVerification currently supports only SAS directly");
    }
    const verifier = await session.request.startVerification(VerificationMethod.Sas);
    this.attachVerifierToVerificationSession(session, verifier);
    this.ensureVerificationStarted(session);
    return this.buildVerificationSummary(session);
  }

  async generateVerificationQr(id: string): Promise<{ qrDataBase64: string }> {
    const session = this.findVerificationSession(id);
    const qr = await session.request.generateQRCode();
    if (!qr) {
      throw new Error("Matrix verification QR data is not available yet");
    }
    return { qrDataBase64: Buffer.from(qr).toString("base64") };
  }

  async scanVerificationQr(id: string, qrDataBase64: string): Promise<MatrixVerificationSummary> {
    const session = this.findVerificationSession(id);
    const trimmed = qrDataBase64.trim();
    if (!trimmed) {
      throw new Error("Matrix verification QR payload is required");
    }
    const qrBytes = Buffer.from(trimmed, "base64");
    if (qrBytes.length === 0) {
      throw new Error("Matrix verification QR payload is invalid base64");
    }
    const verifier = await session.request.scanQRCode(new Uint8ClampedArray(qrBytes));
    this.attachVerifierToVerificationSession(session, verifier);
    this.ensureVerificationStarted(session);
    return this.buildVerificationSummary(session);
  }

  async confirmVerificationSas(id: string): Promise<MatrixVerificationSummary> {
    const session = this.findVerificationSession(id);
    const callbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
    if (!callbacks) {
      throw new Error("Matrix SAS confirmation is not available for this verification request");
    }
    this.clearSasAutoConfirmTimer(session);
    session.sasCallbacks = callbacks;
    session.sasAutoConfirmStarted = true;
    await this.confirmSasForSession(session, callbacks);
    this.touchVerificationSession(session);
    return this.buildVerificationSummary(session);
  }

  mismatchVerificationSas(id: string): MatrixVerificationSummary {
    const session = this.findVerificationSession(id);
    const callbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
    if (!callbacks) {
      throw new Error("Matrix SAS mismatch is not available for this verification request");
    }
    this.clearSasAutoConfirmTimer(session);
    session.sasCallbacks = callbacks;
    callbacks.mismatch();
    this.touchVerificationSession(session);
    return this.buildVerificationSummary(session);
  }

  confirmVerificationReciprocateQr(id: string): MatrixVerificationSummary {
    const session = this.findVerificationSession(id);
    const callbacks =
      session.reciprocateQrCallbacks ?? session.activeVerifier?.getReciprocateQrCodeCallbacks();
    if (!callbacks) {
      throw new Error(
        "Matrix reciprocate-QR confirmation is not available for this verification request",
      );
    }
    session.reciprocateQrCallbacks = callbacks;
    callbacks.confirm();
    this.touchVerificationSession(session);
    return this.buildVerificationSummary(session);
  }

  getVerificationSas(id: string): {
    decimal?: [number, number, number];
    emoji?: Array<[string, string]>;
  } {
    const session = this.findVerificationSession(id);
    const callbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
    if (!callbacks) {
      throw new Error("Matrix SAS data is not available for this verification request");
    }
    session.sasCallbacks = callbacks;
    return {
      decimal: callbacks.sas.decimal,
      emoji: callbacks.sas.emoji,
    };
  }
}
