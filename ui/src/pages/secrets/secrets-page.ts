import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { ENV_SECRET_REF_ID_RE } from "../../../../src/config/types.secrets.js";
import { isSensitiveEnvName } from "../../../../src/secrets/secret-env-name.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  bulkSetSecretsStoreEntries,
  createInitialSecretsStoreState,
  deleteSecretsStoreEntry,
  loadSecretsStore,
  parseSecretsStoreBulkInput,
  setSecretsStoreEntry,
  type SecretsStoreDraft,
  type SecretsStoreState,
} from "../../lib/secrets-store/index.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderSecretsStore, type SecretsDialogMode } from "./view.ts";

const MAX_VALUE_BYTES = 64 * 1024;

class SecretsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private store = createInitialSecretsStoreState();
  @state() private dialogMode: SecretsDialogMode = null;
  @state() private draft: SecretsStoreDraft = {
    name: "",
    value: "",
    kind: "env",
    allowedHosts: "",
  };
  @state() private secretKindOverridden = false;
  @state() private bulkOpen = false;
  @state() private bulkRaw = "";
  @state() private bulkAutoDetect = true;
  @state() private formError: string | null = null;
  @state() private notice: string | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: (change) => this.resetGatewayState(change.snapshot),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetGatewayState(change.snapshot);
      }
    },
    ensureInitialData: () => this.ensureInitialData(),
  });

  private resetGatewayState(snapshot?: ApplicationContext["gateway"]["snapshot"]) {
    this.store = createInitialSecretsStoreState({
      client: snapshot?.client ?? null,
      connected: snapshot?.phase === "connected",
    });
    this.dialogMode = null;
    this.bulkOpen = false;
    this.formError = null;
    this.notice = null;
  }

  private get canList(): boolean {
    return this.canCall("secrets.store.list");
  }

  private get canSet(): boolean {
    return this.canCall("secrets.store.set");
  }

  private get canDelete(): boolean {
    return this.canCall("secrets.store.delete");
  }

  private canCall(method: "secrets.store.list" | "secrets.store.set" | "secrets.store.delete") {
    return (
      isGatewayMethodAdvertised(this.gateway.snapshot ?? {}, method) === true &&
      canCallGatewayMethod(this.gateway.snapshot, method, "operator.admin")
    );
  }

  private ensureInitialData() {
    if (this.canList && !this.store.loaded && !this.store.loading) {
      void this.runStoreTask((store) => loadSecretsStore(store));
    }
  }

  private async runStoreTask<T>(task: (store: SecretsStoreState) => Promise<T>): Promise<T> {
    const store = this.store;
    try {
      const result = task(store);
      this.requestUpdate();
      return await result;
    } finally {
      if (this.store === store) {
        this.requestUpdate();
      }
    }
  }

  private refresh() {
    if (!this.canList) {
      return;
    }
    void this.runStoreTask((store) => loadSecretsStore(store));
  }

  private openAdd() {
    if (!this.canSet) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.secretKindOverridden = false;
    this.draft = { name: "", value: "", kind: "env", allowedHosts: "" };
    this.dialogMode = "add";
  }

  private openEdit(entry: (typeof this.store.entries)[number]) {
    if (!this.canSet) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.secretKindOverridden = true;
    this.draft = {
      name: entry.name,
      value: entry.kind === "env" ? entry.value : "",
      kind: entry.kind,
      allowedHosts: entry.kind === "secret" ? (entry.allowedHosts ?? []).join("\n") : "",
    };
    this.dialogMode = "edit";
  }

  private closeDialog() {
    if (!this.store.busy) {
      this.dialogMode = null;
      this.formError = null;
    }
  }

  private patchDraft(patch: Partial<SecretsStoreDraft>) {
    this.draft = { ...this.draft, ...patch };
    this.formError = null;
  }

  private changeDraftName(name: string) {
    const normalized = name.toUpperCase();
    this.patchDraft({
      name: normalized,
      ...(!this.secretKindOverridden
        ? { kind: isSensitiveEnvName(normalized) ? ("secret" as const) : ("env" as const) }
        : {}),
    });
  }

  private validateValue(value: string, kind: SecretsStoreDraft["kind"]): string | null {
    if (kind === "secret" && value.length === 0) {
      return t("secretsStore.required");
    }
    if (new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) {
      return t("secretsStore.tooLarge");
    }
    return null;
  }

  private validateDraft(): string | null {
    if (!ENV_SECRET_REF_ID_RE.test(this.draft.name)) {
      return t("secretsStore.badName");
    }
    return this.validateValue(this.draft.value, this.draft.kind);
  }

  private submitDraft() {
    if (!this.canSet || !this.dialogMode) {
      return;
    }
    const error = this.validateDraft();
    if (error) {
      this.formError = error;
      return;
    }
    const draft = { ...this.draft };
    void this.runStoreTask(async (store) => {
      const result = await setSecretsStoreEntry(store, draft);
      if (this.store !== store) {
        return;
      }
      if (!result) {
        this.formError = store.error;
        return;
      }
      this.dialogMode = null;
      this.formError = null;
      const saved = t(
        draft.kind === "secret" ? "secretsStore.savedProtected" : "secretsStore.savedReadable",
        { name: draft.name },
      );
      this.notice = result.warningCount
        ? `${saved} ${t("secretsStore.warnings", { count: String(result.warningCount) })}`
        : saved;
    });
  }

  private openBulk() {
    if (!this.canSet) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.bulkRaw = "";
    this.bulkAutoDetect = true;
    this.bulkOpen = true;
  }

  private closeBulk() {
    if (!this.store.busy) {
      this.bulkOpen = false;
      this.formError = null;
    }
  }

  private get bulkParsed() {
    return parseSecretsStoreBulkInput(this.bulkRaw, this.bulkAutoDetect);
  }

  private submitBulk() {
    if (!this.canSet || !this.bulkOpen) {
      return;
    }
    const parsed = this.bulkParsed;
    if (parsed.invalidNames.length > 0) {
      this.formError = `${t("secretsStore.badName")} ${parsed.invalidNames.join(", ")}`;
      return;
    }
    if (parsed.entries.length === 0) {
      this.formError = t("secretsStore.required");
      return;
    }
    for (const entry of parsed.entries) {
      const error = this.validateValue(entry.value, entry.kind);
      if (error) {
        this.formError = `${entry.name}: ${error}`;
        return;
      }
    }
    void this.runStoreTask(async (store) => {
      const result = await bulkSetSecretsStoreEntries(store, parsed.entries);
      if (this.store !== store) {
        return;
      }
      if (!result) {
        this.formError = store.error;
        return;
      }
      this.bulkOpen = false;
      this.formError = null;
      const saved = t("secretsStore.savedMany", {
        count: String(result.saved),
        protected: String(parsed.entries.filter((entry) => entry.kind === "secret").length),
        readable: String(parsed.entries.filter((entry) => entry.kind === "env").length),
      });
      this.notice = result.warningCount
        ? `${saved} ${t("secretsStore.warnings", { count: String(result.warningCount) })}`
        : saved;
    });
  }

  private async removeEntry(entry: (typeof this.store.entries)[number]) {
    // A confirmation belongs to the client that opened it. Same-client reconnects remain valid,
    // but a replacement client must never inherit this destructive action.
    const gateway = this.context.gateway;
    const client = this.store.client;
    if (
      !client ||
      !this.canDelete ||
      !(await showConfirmDialog({
        title: t("common.delete"),
        message: t("secretsStore.confirmDelete", { name: entry.name }),
        confirmLabel: t("common.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    this.notice = null;
    if (this.context.gateway !== gateway || this.store.client !== client || !this.canDelete) {
      this.store.error = t("secretsStore.deleteFailed");
      this.requestUpdate();
      return;
    }
    await this.runStoreTask(async (store) => {
      const result = await deleteSecretsStoreEntry(store, entry.name);
      if (result && this.store === store) {
        this.notice = t("secretsStore.deleted", { name: entry.name });
      }
    });
  }

  override render() {
    const parsed = this.bulkParsed;
    const body = renderSecretsStore({
      entries: this.store.entries,
      loading: this.store.loading,
      busy: this.store.busy,
      error: this.store.error,
      notice: this.notice,
      canList: this.canList,
      canSet: this.canSet,
      canDelete: this.canDelete,
      dialogMode: this.dialogMode,
      draft: this.draft,
      formError: this.formError,
      bulkOpen: this.bulkOpen,
      bulkRaw: this.bulkRaw,
      bulkAutoDetect: this.bulkAutoDetect,
      bulkSecretCount: parsed.entries.filter((entry) => entry.kind === "secret").length,
      bulkEntryCount: parsed.entries.length,
      bulkInvalidNames: parsed.invalidNames,
      onRefresh: () => this.refresh(),
      onOpenAdd: () => this.openAdd(),
      onOpenEdit: (entry) => this.openEdit(entry),
      onCloseDialog: () => this.closeDialog(),
      onDraftNameChange: (name) => this.changeDraftName(name),
      onDraftValueChange: (value) => this.patchDraft({ value }),
      onDraftAllowedHostsChange: (allowedHosts) => this.patchDraft({ allowedHosts }),
      onDraftKindChange: (kind) => {
        this.secretKindOverridden = true;
        this.patchDraft({ kind });
      },
      onSubmitDraft: () => this.submitDraft(),
      onOpenBulk: () => this.openBulk(),
      onCloseBulk: () => this.closeBulk(),
      onBulkRawChange: (raw) => {
        this.bulkRaw = raw;
        this.formError = null;
      },
      onBulkAutoDetectChange: (enabled) => {
        this.bulkAutoDetect = enabled;
        this.formError = null;
      },
      onSubmitBulk: () => this.submitBulk(),
      onDelete: (entry) => void this.removeEntry(entry),
    });
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("secrets"),
        subtitle: t("secretsStore.hint"),
      })}
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-secrets-page")) {
  customElements.define("openclaw-secrets-page", SecretsPage);
}
