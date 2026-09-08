import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReactiveControllerHost } from "lit";
import type {
  SkillsProposalInspectResult,
  SkillsProposalApplyResult,
  SkillLibraryEntry,
  SkillLibraryFile,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
  SkillsLibraryMutateParams,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { libraryFileText, readLibraryFiles, uploadLibraryArchive } from "./library-files.ts";

export type LibraryView = "workspace" | "mine" | "team" | "all";
export type LibraryDraft = {
  target: "workspace" | "personal";
  connection: GatewayConnectionScope;
  agentId: string | null;
  entry: SkillLibraryEntry | null;
  slug: string;
  description: string;
  content: string;
  files: SkillLibraryFile[];
  revisions: SkillsLibraryReadResult["revisions"];
  selectedFile: string;
  rollbackRevision: string;
  dirty: boolean;
  proposal: SkillsProposalInspectResult | null;
};

export class SkillLibraryController {
  list: SkillsLibraryListResult | null = null;
  view: LibraryView | null = null;
  loading = false;
  busy = false;
  error: string | null = null;
  notice: string | null = null;
  draft: LibraryDraft | null = null;
  private importVisible = false;
  importSlug = "";
  importSource: { slug: string; version?: string } | null = null;
  importSelection: File[] = [];
  newFilePath = "";
  query = "";
  private readSequence = 0;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly gateway: GatewayPageController,
    private readonly selectedAgent: () => string | null,
    private readonly refreshWorkspace: () => Promise<void>,
  ) {}

  changed() {
    this.host.requestUpdate();
  }
  private clearFeedback() {
    this.error = null;
    this.notice = null;
  }
  get importOpen() {
    return this.importVisible;
  }
  set importOpen(open: boolean) {
    this.clearFeedback();
    this.importVisible = open;
    if (!open) {
      this.importSlug = "";
      this.importSource = null;
      this.importSelection = [];
    }
  }
  reset() {
    this.readSequence++;
    this.list = null;
    this.view = null;
    this.loading = false;
    this.busy = false;
    this.draft = null;
    this.importOpen = false;
    this.newFilePath = "";
    this.query = "";
  }
  get showWorkspace() {
    return this.view === null || this.view === "workspace";
  }
  get canWrite() {
    return canCallGatewayMethod(this.gateway.snapshot, "skills.library.save", "operator.write", {
      requireAdvertisement: false,
    });
  }
  get canTransfer() {
    return canCallGatewayMethod(this.gateway.snapshot, "skills.library.mutate", "operator.admin", {
      requireAdvertisement: false,
    });
  }
  get createTarget() {
    if (this.showWorkspace && this.list?.canManageWorkspace) {
      return "workspace";
    }
    return this.list?.profileId ? "personal" : "unavailable";
  }
  get canCreate() {
    if (this.loading) {
      return false;
    }
    if (this.createTarget === "workspace") {
      return canCallGatewayMethod(
        this.gateway.snapshot,
        "skills.proposals.create",
        "operator.admin",
        { requireAdvertisement: false },
      );
    }
    return this.createTarget === "personal" && this.canWrite;
  }
  get canEdit() {
    return this.canWrite && (this.draft?.entry?.canEdit ?? true);
  }

  async load() {
    const connection = this.gateway.capture();
    if (!connection || this.loading) {
      return;
    }
    this.loading = true;
    this.error = null;
    this.changed();
    try {
      const result = await connection.client.request<SkillsLibraryListResult>(
        "skills.library.list",
        { scope: "all" },
      );
      if (!this.gateway.isCurrent(connection)) {
        return;
      }
      this.list = result;
      this.view ??= result.defaultTarget === "personal" ? "mine" : "workspace";
    } catch (error) {
      if (this.gateway.isCurrent(connection)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(connection)) {
        this.loading = false;
        this.changed();
      }
    }
  }

  create() {
    const connection = this.gateway.capture();
    if (!connection || !this.canCreate || this.createTarget === "unavailable") {
      return;
    }
    this.draft = {
      target: this.createTarget,
      connection,
      agentId: this.selectedAgent(),
      entry: null,
      slug: "",
      description: "",
      content: "",
      files: [],
      revisions: [],
      selectedFile: "SKILL.md",
      rollbackRevision: "",
      dirty: false,
      proposal: null,
    };
    this.clearFeedback();
    this.newFilePath = "";
    this.changed();
  }

  close() {
    if (this.busy || (this.draft?.dirty && !window.confirm(t("skillLibrary.discard")))) {
      return;
    }
    this.readSequence++;
    this.draft = null;
    this.importOpen = false;
    this.newFilePath = "";
    this.changed();
  }

  async open(skillId: string) {
    if (this.draft?.dirty && !window.confirm(t("skillLibrary.discard"))) {
      return;
    }
    const connection = this.gateway.capture();
    if (!connection || this.busy) {
      return;
    }
    const sequence = ++this.readSequence;
    await this.perform(async () => {
      const read = await connection.client.request<SkillsLibraryReadResult>("skills.library.read", {
        skillId,
      });
      if (!this.gateway.isCurrent(connection) || sequence !== this.readSequence) {
        return;
      }
      this.draft = {
        target: "personal",
        connection,
        agentId: null,
        entry: read.entry,
        slug: read.entry.slug,
        description: read.entry.description,
        content: read.content,
        files: read.files,
        revisions: read.revisions,
        selectedFile: "SKILL.md",
        rollbackRevision: "",
        dirty: false,
        proposal: null,
      };
    });
  }

  async perform(action: () => Promise<void>) {
    if (this.busy || this.loading) {
      return;
    }
    const connection = this.gateway.capture();
    if (!connection) {
      this.error = t("skillLibrary.connectionChanged");
      this.changed();
      return;
    }
    this.busy = true;
    this.clearFeedback();
    this.changed();
    try {
      await action();
    } catch (error) {
      if (this.gateway.isCurrent(connection)) {
        const code =
          error instanceof GatewayRequestError ? asNullableRecord(error.details)?.code : undefined;
        this.error =
          code === "SKILL_LIBRARY_CONFLICT"
            ? t("skillLibrary.conflict")
            : code === "SKILL_LIBRARY_IDENTITY_REQUIRED"
              ? t("skillLibrary.signIn")
              : formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(connection)) {
        this.busy = false;
        this.changed();
      }
    }
  }

  private async receipt(receipt: SkillsLibraryReceipt) {
    this.notice =
      t(`skillLibrary.receipt.${receipt.state}`, {
        slug: receipt.entry.slug,
        target: receipt.target,
        owner: receipt.entry.ownerLabel,
      }) +
      " " +
      receipt.nextAction;
    await this.load();
  }

  async save() {
    const draft = this.draft;
    if (!draft || !this.canEdit) {
      return;
    }
    await this.perform(async () => {
      if (!this.gateway.isCurrent(draft.connection)) {
        throw new Error(t("skillLibrary.connectionChanged"));
      }
      const client = draft.connection.client;
      if (draft.target === "workspace") {
        if (!draft.agentId) {
          throw new Error(t("skillLibrary.selectAgent"));
        }
        const supportFiles = draft.files.map((file) => {
          const content = libraryFileText(file);
          if (content === null || file.executable) {
            throw new Error(t("skillLibrary.workspaceTextOnly"));
          }
          return { path: file.path, content };
        });
        const proposal = await client.request<SkillsProposalInspectResult>(
          "skills.proposals.create",
          {
            agentId: draft.agentId,
            name: draft.slug,
            description: draft.description,
            content: draft.content,
            supportFiles,
          },
        );
        if (!this.gateway.isCurrent(draft.connection)) {
          return;
        }
        draft.proposal = proposal;
        draft.dirty = false;
        this.notice = t("skillLibrary.pending", { id: proposal.record.id, agent: draft.agentId });
        return;
      }
      const receipt = await client.request<SkillsLibraryReceipt>("skills.library.save", {
        ...(draft.entry ? { skillId: draft.entry.skillId } : {}),
        expectedRevision: draft.entry?.revision ?? null,
        slug: draft.slug,
        content: draft.content,
        files: draft.files,
      });
      if (!this.gateway.isCurrent(draft.connection)) {
        return;
      }
      draft.entry = receipt.entry;
      draft.dirty = false;
      draft.revisions = [
        { revision: receipt.entry.revision, createdAt: receipt.entry.updatedAt },
        ...draft.revisions.filter((item) => item.revision !== receipt.entry.revision),
      ];
      await this.receipt(receipt);
    });
  }

  async applyWorkspace() {
    const draft = this.draft;
    const proposal = draft?.proposal;
    const agentId = draft?.agentId;
    if (!draft || !proposal || !agentId) {
      return;
    }
    await this.perform(async () => {
      if (!this.gateway.isCurrent(draft.connection)) {
        throw new Error(t("skillLibrary.connectionChanged"));
      }
      const result = await draft.connection.client.request<SkillsProposalApplyResult>(
        "skills.proposals.apply",
        {
          agentId,
          proposalId: proposal.record.id,
          expectedRevisionHash: proposal.revisionHash,
        },
      );
      if (!this.gateway.isCurrent(draft.connection)) {
        return;
      }
      this.draft = null;
      this.notice = t("skillLibrary.workspaceSaved", {
        agent: agentId,
        state: result.record.status,
      });
      await this.refreshWorkspace();
    });
  }

  async mutate(action: SkillsLibraryMutateParams["action"]) {
    const draft = this.draft;
    const entry = draft?.entry;
    if (!draft || !entry || !this.canEdit || draft.dirty) {
      return;
    }
    if (
      (action === "remove" || action === "transfer") &&
      !window.confirm(t(`skillLibrary.confirm.${action}`, { slug: draft.slug }))
    ) {
      return;
    }
    await this.perform(async () => {
      if (!this.gateway.isCurrent(draft.connection)) {
        throw new Error(t("skillLibrary.connectionChanged"));
      }
      const receipt = await draft.connection.client.request<SkillsLibraryReceipt>(
        "skills.library.mutate",
        {
          skillId: entry.skillId,
          expectedRevision: entry.revision,
          action,
          ...(action === "rollback" ? { revision: draft.rollbackRevision } : {}),
        },
      );
      if (!this.gateway.isCurrent(draft.connection)) {
        return;
      }
      if (action === "remove") {
        this.draft = null;
      }
      // Record the committed mutation even if the follow-up list or revision read fails.
      await this.receipt(receipt);
      if (!this.gateway.isCurrent(draft.connection)) {
        return;
      }
      if (action !== "remove") {
        if (action === "rollback") {
          const read = await draft.connection.client.request<SkillsLibraryReadResult>(
            "skills.library.read",
            { skillId: receipt.entry.skillId, revision: receipt.entry.revision },
          );
          if (!this.gateway.isCurrent(draft.connection)) {
            return;
          }
          draft.content = read.content;
          draft.files = read.files;
          draft.revisions = read.revisions;
          draft.selectedFile = "SKILL.md";
          draft.rollbackRevision = "";
        }
        draft.entry = receipt.entry;
      }
    });
  }

  async importFiles(files: File[]) {
    if (!files.length) {
      return;
    }
    const connection = this.gateway.capture();
    if (!connection) {
      return;
    }
    await this.perform(async () => {
      const [file] = files;
      if (file && files.length === 1 && file.name.toLowerCase().endsWith(".zip")) {
        if (this.createTarget === "workspace") {
          throw new Error(t("skillLibrary.workspaceTextOnly"));
        }
        if (!this.list?.profileId) {
          throw new Error(t("skillLibrary.signIn"));
        }
        const receipt = await uploadLibraryArchive(connection.client, file, this.importSlug, () =>
          this.gateway.isCurrent(connection),
        );
        if (this.gateway.isCurrent(connection)) {
          this.importOpen = false;
          await this.receipt(receipt);
        }
        return;
      }
      const bundle = await readLibraryFiles(files);
      if (!this.gateway.isCurrent(connection)) {
        return;
      }
      this.create();
      if (this.draft) {
        Object.assign(this.draft, bundle, { slug: this.importSlug, dirty: true });
        this.importOpen = false;
      }
    });
  }

  async importClawHub(slug: string, sourceSlug: string, version?: string) {
    const connection = this.gateway.capture();
    if (!connection || !this.list?.profileId || !this.canWrite) {
      return;
    }
    await this.perform(async () => {
      const receipt = await connection.client.request<SkillsLibraryReceipt>(
        "skills.library.import",
        { slug, source: { kind: "clawhub", slug: sourceSlug, ...(version ? { version } : {}) } },
      );
      if (this.gateway.isCurrent(connection)) {
        this.importOpen = false;
        await this.receipt(receipt);
      }
    });
  }
}
