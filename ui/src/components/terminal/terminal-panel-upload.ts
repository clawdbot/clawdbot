import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { html, nothing, svg } from "lit";
import { t } from "../../i18n/index.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  encodeTerminalUpload,
  quoteTerminalUploadPath,
  uploadTerminalFile,
} from "./terminal-file-upload.ts";

const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const DOCK_BOTTOM_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 10h12" /></svg>`;
const DOCK_RIGHT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>`;
const UPLOAD_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 8.1 9.8 3.5a2.5 2.5 0 0 1 3.5 3.5l-6 6a3.5 3.5 0 0 1-5-5l5.8-5.8" /><path d="m4.4 9 5.2-5.2a1.4 1.4 0 0 1 2 2l-5.3 5.3a2.3 2.3 0 0 1-3.2-3.2l4.6-4.6" /></svg>`;

type TerminalUploadTab = {
  gatewaySessionId: string;
  shell: string;
  status: string;
  controller: GhosttyTerminalController;
};

type TerminalPanelUploadHost = {
  activeTab: () => TerminalUploadTab | undefined;
  client: () => TerminalGatewayClient | null;
  isCurrent: (tab: TerminalUploadTab) => boolean;
  fileInput: () => HTMLInputElement | null;
  setError: (message: string | null) => void;
  requestUpdate: () => void;
};

type TerminalUploadBatch = {
  tab: TerminalUploadTab;
  files: File[];
  paths: string[];
  nextIndex: number;
  state: "uploading" | "failed";
  error: string | null;
  retryable: boolean;
  abortController: AbortController;
};

type TerminalUploadProgress = {
  completed: number;
  current: number;
  error: string | null;
  fileName: string;
  retryable: boolean;
  state: TerminalUploadBatch["state"];
  total: number;
};

function isRetryableUploadError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "retryable" in error) {
    const gatewayError = error as { gatewayCode?: unknown; code?: unknown; retryable?: unknown };
    if (gatewayError.gatewayCode === "UNAVAILABLE" || gatewayError.code === "UNAVAILABLE") {
      return true;
    }
    return gatewayError.retryable === true;
  }
  return true;
}

export class TerminalPanelUploadController {
  dragActive = false;
  private batch: TerminalUploadBatch | null = null;
  private dragDepth = 0;

  constructor(private readonly host: TerminalPanelUploadHost) {}

  hasActiveTab(): boolean {
    return Boolean(this.host.activeTab());
  }

  hasPendingBatch(): boolean {
    return this.batch !== null;
  }

  get progress(): TerminalUploadProgress | null {
    const batch = this.batch;
    if (!batch) {
      return null;
    }
    const total = batch.files.length;
    const currentIndex = Math.min(batch.nextIndex, total - 1);
    return {
      completed: batch.nextIndex,
      current: currentIndex + 1,
      error: batch.error,
      fileName: batch.files[currentIndex]?.name ?? "",
      retryable: batch.retryable,
      state: batch.state,
      total,
    };
  }

  chooseFiles = (): void => {
    this.host.fileInput()?.click();
  };

  handleFileSelection = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    this.uploadFiles(files);
  };

  private hasDraggedFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  handleDragEnter = (event: DragEvent): void => {
    if (!this.hasDraggedFiles(event) || !this.hasActiveTab() || this.hasPendingBatch()) {
      return;
    }
    event.preventDefault();
    this.dragDepth += 1;
    this.dragActive = true;
    this.host.requestUpdate();
  };

  handleDragOver = (event: DragEvent): void => {
    if (!this.hasDraggedFiles(event) || !this.hasActiveTab() || this.hasPendingBatch()) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  };

  handleDragLeave = (event: DragEvent): void => {
    if (!this.hasDraggedFiles(event)) {
      return;
    }
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.dragActive = false;
      this.host.requestUpdate();
    }
  };

  handleDrop = (event: DragEvent): void => {
    if (!this.hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    this.dragDepth = 0;
    this.dragActive = false;
    this.host.requestUpdate();
    if (this.hasPendingBatch()) {
      return;
    }
    this.uploadFiles(Array.from(event.dataTransfer?.files ?? []));
  };

  private uploadFiles(files: File[]): void {
    const tab = this.host.activeTab();
    if (files.length === 0 || !tab || !this.host.client() || this.hasPendingBatch()) {
      return;
    }
    this.host.setError(null);
    const batch: TerminalUploadBatch = {
      tab,
      files,
      paths: [],
      nextIndex: 0,
      state: "uploading",
      error: null,
      retryable: false,
      abortController: new AbortController(),
    };
    this.batch = batch;
    this.host.requestUpdate();
    void this.runBatch(batch);
  }

  private isActive(batch: TerminalUploadBatch): boolean {
    return this.batch === batch && !batch.abortController.signal.aborted;
  }

  private ensureCurrent(batch: TerminalUploadBatch): boolean {
    if (!this.isActive(batch)) {
      return false;
    }
    if (!this.host.isCurrent(batch.tab)) {
      this.cancelBatch(batch);
      return false;
    }
    return true;
  }

  private failBatch(batch: TerminalUploadBatch, error: unknown, retryable: boolean): void {
    if (!this.ensureCurrent(batch)) {
      return;
    }
    batch.state = "failed";
    batch.error = error instanceof Error ? error.message : String(error);
    batch.retryable = retryable;
    this.host.requestUpdate();
  }

  private async runBatch(batch: TerminalUploadBatch): Promise<void> {
    const client = this.host.client();
    if (!client || !this.ensureCurrent(batch)) {
      this.cancelBatch(batch);
      return;
    }
    while (batch.nextIndex < batch.files.length) {
      const file = batch.files[batch.nextIndex];
      if (!file || !this.ensureCurrent(batch)) {
        return;
      }
      this.host.requestUpdate();

      let contentBase64: string;
      try {
        contentBase64 = await encodeTerminalUpload(file);
      } catch (error) {
        this.failBatch(batch, error, false);
        return;
      }
      if (!this.ensureCurrent(batch)) {
        return;
      }

      let uploadedPath: string;
      try {
        const result = await uploadTerminalFile(
          client,
          batch.tab.gatewaySessionId,
          { name: file.name, contentBase64 },
          batch.abortController.signal,
        );
        if (!this.ensureCurrent(batch)) {
          return;
        }
        uploadedPath = result.path;
      } catch (error) {
        this.failBatch(batch, error, isRetryableUploadError(error));
        return;
      }
      try {
        uploadedPath = quoteTerminalUploadPath(uploadedPath, batch.tab.shell);
      } catch (error) {
        this.failBatch(batch, error, false);
        return;
      }

      batch.paths.push(uploadedPath);
      batch.nextIndex += 1;
      this.host.requestUpdate();
    }

    if (!this.ensureCurrent(batch)) {
      return;
    }
    // Ghostty preserves bracketed-paste mode. This produces editable input,
    // never Enter, so adding a file cannot execute a shell command.
    batch.tab.controller.terminal.paste(batch.paths.join(" "));
    batch.tab.controller.terminal.focus();
    this.batch = null;
    this.host.requestUpdate();
  }

  retry = (): void => {
    const batch = this.batch;
    if (!batch || batch.state !== "failed" || !batch.retryable) {
      return;
    }
    if (!this.host.isCurrent(batch.tab) || !this.host.client()) {
      this.cancelBatch(batch);
      return;
    }
    batch.state = "uploading";
    batch.error = null;
    batch.retryable = false;
    batch.abortController = new AbortController();
    this.host.requestUpdate();
    void this.runBatch(batch);
  };

  cancel = (): void => {
    const batch = this.batch;
    if (batch) {
      this.cancelBatch(batch);
    }
  };

  cancelForTab(tab: TerminalUploadTab): void {
    const batch = this.batch;
    if (batch?.tab === tab) {
      this.cancelBatch(batch);
    }
  }

  private cancelBatch(batch: TerminalUploadBatch): void {
    if (this.batch !== batch) {
      return;
    }
    batch.abortController.abort();
    this.batch = null;
    this.dragActive = false;
    this.dragDepth = 0;
    this.host.requestUpdate();
  }

  dispose(): void {
    this.batch?.abortController.abort();
    this.batch = null;
    this.dragActive = false;
    this.dragDepth = 0;
  }
}

export function renderTerminalPanelActions(params: {
  fullscreen: boolean;
  dock: "bottom" | "right";
  upload: TerminalPanelUploadController;
  sessionPicker: unknown;
  onDock: (dock: "bottom" | "right") => void;
  onHide: () => void;
}) {
  return html`<div class="tp-actions">
    <input
      class="tp-file-input"
      type="file"
      multiple
      aria-hidden="true"
      tabindex="-1"
      @change=${params.upload.handleFileSelection}
    />
    <button
      class="tp-icon tp-upload"
      type="button"
      title=${t("terminal.addFiles")}
      aria-label=${t("terminal.addFiles")}
      ?disabled=${params.upload.hasPendingBatch() || !params.upload.hasActiveTab()}
      @click=${params.upload.chooseFiles}
    >
      ${UPLOAD_GLYPH}
    </button>
    ${params.fullscreen
      ? nothing
      : html`${params.sessionPicker}<button
            class="tp-icon ${params.dock === "bottom" ? "is-active" : ""}"
            type="button"
            title=${t("terminal.dockBottom")}
            aria-label=${t("terminal.dockBottom")}
            @click=${() => params.onDock("bottom")}
          >
            ${DOCK_BOTTOM_GLYPH}
          </button>
          <button
            class="tp-icon ${params.dock === "right" ? "is-active" : ""}"
            type="button"
            title=${t("terminal.dockRight")}
            aria-label=${t("terminal.dockRight")}
            @click=${() => params.onDock("right")}
          >
            ${DOCK_RIGHT_GLYPH}
          </button>
          <button
            class="tp-icon"
            type="button"
            title=${t("terminal.hide")}
            aria-label=${t("terminal.hide")}
            @click=${params.onHide}
          >
            ${CLOSE_GLYPH}
          </button>`}
  </div>`;
}

export function renderTerminalUploadLayer(upload: TerminalPanelUploadController) {
  const progress = upload.progress;
  return html`${upload.dragActive
    ? html`<div class="tp-drop-overlay">${t("terminal.dropFiles")}</div>`
    : nothing}
  ${progress
    ? html`<div
        class="tp-upload-card ${progress.state === "failed" ? "tp-upload-card--failed" : ""}"
        role=${progress.state === "failed" ? "alert" : "status"}
        aria-live=${progress.state === "failed" ? "assertive" : "polite"}
      >
        <div class="tp-upload-card__header">
          <div class="tp-upload-card__copy">
            <div class="tp-upload-card__title">
              ${progress.state === "failed"
                ? t("terminal.uploadFailed")
                : t("terminal.uploadProgress", {
                    current: String(progress.current),
                    total: String(progress.total),
                  })}
            </div>
            <div class="tp-upload-card__file">${progress.fileName}</div>
          </div>
          <div class="tp-upload-card__actions">
            ${progress.state === "failed" && progress.retryable
              ? html`<button
                  class="tp-upload-card__action tp-upload-retry"
                  type="button"
                  @click=${upload.retry}
                >
                  ${t("terminal.retryUpload")}
                </button>`
              : nothing}
            <button
              class="tp-upload-card__action tp-upload-cancel"
              type="button"
              @click=${upload.cancel}
            >
              ${t("common.cancel")}
            </button>
          </div>
        </div>
        <div
          class="tp-upload-progress"
          role="progressbar"
          aria-label=${progress.state === "failed"
            ? t("terminal.uploadFailed")
            : t("terminal.uploadProgress", {
                current: String(progress.current),
                total: String(progress.total),
              })}
          aria-valuemin="0"
          aria-valuemax=${String(progress.total)}
          aria-valuenow=${String(progress.completed)}
        >
          <span
            class="tp-upload-progress__fill"
            style=${`width:${(progress.completed / progress.total) * 100}%`}
          ></span>
          ${progress.state === "uploading"
            ? html`<span class="tp-upload-progress__activity"></span>`
            : nothing}
        </div>
        ${progress.error
          ? html`<div class="tp-upload-card__error">${progress.error}</div>`
          : nothing}
      </div>`
    : nothing}`;
}
