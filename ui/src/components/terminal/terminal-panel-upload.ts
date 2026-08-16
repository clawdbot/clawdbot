import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { renderDockDestinations } from "../dock-destination-controls.ts";
import { icons } from "../icons.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  encodeTerminalUpload,
  quoteTerminalUploadPath,
  uploadTerminalFile,
} from "./terminal-file-upload.ts";

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
  embedded?: boolean;
  dock: "bottom" | "right" | "main";
  upload: TerminalPanelUploadController;
  sessionPicker: unknown;
  onDock: (dock: "bottom" | "right" | "main") => void;
  onOpenFullscreen: () => void;
  onHide: () => void;
}) {
  return html`<div class="rail-header__actions tp-actions">
    <input
      class="tp-file-input"
      type="file"
      multiple
      aria-hidden="true"
      tabindex="-1"
      @change=${params.upload.handleFileSelection}
    />
    <button
      class="rail-header__action tp-icon tp-upload"
      type="button"
      title=${t("terminal.addFiles")}
      aria-label=${t("terminal.addFiles")}
      ?disabled=${params.upload.hasPendingBatch() || !params.upload.hasActiveTab()}
      @click=${params.upload.chooseFiles}
    >
      ${icons.paperclip}
    </button>
    ${params.fullscreen
      ? nothing
      : html`${params.sessionPicker}${params.embedded
          ? html`<button
              class="rail-header__action tp-icon"
              type="button"
              title=${t("terminal.dockBottom")}
              aria-label=${t("terminal.dockBottom")}
              @click=${() => params.onDock("bottom")}
            >
              ${icons.panelBottomOpen}
            </button>`
          : html`${renderDockDestinations({
                current: params.dock,
                groupClass: "tp-dock-modes",
                groupLabel: t("terminal.dockMode"),
                destinations: [
                  {
                    dock: "bottom",
                    label: t("terminal.dockBottom"),
                    icon: icons.panelBottomOpen,
                    className: "tp-icon",
                  },
                  {
                    dock: "right",
                    label: t("terminal.dockRight"),
                    icon: icons.panelRightOpen,
                    className: "tp-icon",
                  },
                  {
                    dock: "main",
                    label: t("terminal.dockMain"),
                    icon: icons.columns2,
                    className: "tp-icon",
                  },
                ],
                onSelect: params.onDock,
              })}
              <button
                class="rail-header__action tp-icon tp-open-fullscreen"
                type="button"
                title=${t("terminal.openFullscreen")}
                aria-label=${t("terminal.openFullscreen")}
                @click=${params.onOpenFullscreen}
              >
                ${icons.maximize}
              </button>
              <button
                class="rail-header__action tp-icon"
                type="button"
                title=${t("terminal.hide")}
                aria-label=${t("terminal.hide")}
                @click=${params.onHide}
              >
                ${icons.x}
              </button>`}`}
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
