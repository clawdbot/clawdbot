import type {
  SkillsLibraryActivateParams,
  SkillsLibraryActivateResult,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillLibraryEnglish } from "../../i18n/locales/en-skill-library.ts";
import {
  invalidateChatMetadataStore,
  revalidateChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { invalidateSessionSlashCommands } from "./chat-commands.ts";

registerSkillLibraryEnglish();

export type LibrarySessionTarget = {
  client: GatewayBrowserClient;
  connectionEpoch: number;
  sessionKey: string;
  agentId: string;
  isCurrent: () => boolean;
};
export type ComposerLibraryProps = {
  result: SkillsLibraryListResult | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  canWrite: boolean;
  onReload: () => void;
  onRead: (skillId: string, revision: string) => void;
  onActivate: (
    action: SkillsLibraryActivateParams["action"],
    skillId?: string,
    revision?: string,
  ) => void;
};

/** One active session owns these pins; the viewer's general library never supplies selections. */
export class ComposerLibrarySession {
  result: SkillsLibraryListResult | null = null;
  loading = false;
  busy = false;
  error: string | null = null;
  notice: string | null = null;
  read: SkillsLibraryReadResult | null = null;
  selectedFile = "SKILL.md";
  private target: LibrarySessionTarget | null = null;
  private readOwner: object | null = null;

  constructor(private readonly notify: () => void) {}

  synchronize(target: LibrarySessionTarget | null) {
    const previous = this.target;
    if (
      previous?.client === target?.client &&
      previous?.connectionEpoch === target?.connectionEpoch &&
      previous?.sessionKey === target?.sessionKey &&
      previous?.agentId === target?.agentId
    ) {
      return;
    }
    this.target = target;
    this.result = null;
    this.loading = false;
    this.busy = false;
    this.error = null;
    this.notice = null;
    this.closeRead();
  }
  private current(target: LibrarySessionTarget) {
    return this.target === target && target.isCurrent();
  }
  closeRead() {
    this.readOwner = null;
    this.read = null;
    this.selectedFile = "SKILL.md";
  }

  async load(force = false) {
    const target = this.target;
    if (!target || !this.current(target) || this.loading || (this.result && !force)) {
      return;
    }
    this.loading = true;
    this.error = null;
    this.notify();
    try {
      const result = await target.client.request<SkillsLibraryListResult>("skills.library.list", {
        sessionKey: target.sessionKey,
      });
      if (this.current(target)) {
        this.result = result;
      }
    } catch (error) {
      if (this.current(target)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.current(target)) {
        this.loading = false;
        this.notify();
      }
    }
  }

  async openRead(skillId: string, revision: string) {
    const target = this.target;
    if (!target || !this.current(target) || this.busy || this.loading) {
      return;
    }
    const owner = {};
    this.readOwner = owner;
    this.error = null;
    this.busy = true;
    this.notify();
    try {
      const read = await target.client.request<SkillsLibraryReadResult>("skills.library.read", {
        sessionKey: target.sessionKey,
        skillId,
        revision,
      });
      if (this.current(target) && this.readOwner === owner) {
        this.read = read;
        this.selectedFile = "SKILL.md";
      }
    } catch (error) {
      if (this.current(target) && this.readOwner === owner) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.current(target)) {
        this.busy = false;
        this.notify();
      }
    }
  }

  async activate(
    action: SkillsLibraryActivateParams["action"],
    skillId?: string,
    revision?: string,
  ) {
    const target = this.target;
    if (!target || !this.current(target) || this.busy || this.loading) {
      return;
    }
    this.busy = true;
    this.error = null;
    this.notice = null;
    this.notify();
    try {
      await target.client.request<SkillsLibraryActivateResult>("skills.library.activate", {
        action,
        sessionKey: target.sessionKey,
        ...(skillId ? { skillId } : {}),
        ...(revision ? { revision } : {}),
      });
      if (!this.current(target)) {
        return;
      }
      this.notice = t("skillLibrary.session.queued");
      this.result = null;
      this.closeRead();
      // Both catalog owners must retire their previous pins after an explicit activation.
      const scope = { agentId: target.agentId, sessionKey: target.sessionKey };
      invalidateSessionSlashCommands(target.client, scope);
      invalidateChatMetadataStore(target.client, scope);
      await Promise.all([this.load(), revalidateChatMetadata(target.client, scope)]);
    } catch (error) {
      if (this.current(target)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.current(target)) {
        this.busy = false;
        this.notify();
      }
    }
  }
}
