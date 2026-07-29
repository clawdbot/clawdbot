import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SkillStatusEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import "../../components/modal-dialog.ts";
import { renderMcpServerForm, type McpServerForm } from "../../components/mcp-server-form.ts";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import {
  buildAddMcpServerPatch,
  MCP_SERVER_NAME_PATTERN,
  parseMcpTarget,
  patchMcpServers,
  summarizeMcpServers,
} from "../../lib/config/mcp-servers.ts";
import {
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
} from "../../lib/sessions/index.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { nextBooleanToolOverrides } from "../../lib/sessions/tool-overrides.ts";
import { loadSkillStatusReport } from "../../lib/skills/index.ts";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type {
  ChatComposerMenuSkill,
  ChatComposerPlusMenuProps,
} from "./components/chat-composer-plus-menu.ts";

type CapabilityMenuProps = Omit<
  ChatComposerPlusMenuProps,
  | "attachments"
  | "disabled"
  | "open"
  | "view"
  | "toolOverrides"
  | "onOpenChange"
  | "onViewChange"
  | "showCapabilities"
>;

type ComposerMcpServerScope = "session" | "everywhere";

type CapabilityMutationResult =
  | { ok: true }
  | { ok: false; error: string; stage: "config" | "session" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function webSearchBaseEnabled(config: Record<string, unknown> | null): boolean {
  return asRecord(asRecord(asRecord(config?.tools)?.web)?.search)?.enabled !== false;
}

function toComposerSkill(skill: SkillStatusEntry): ChatComposerMenuSkill {
  const missingDeps = Object.values(skill.missing).some((values) => values.length > 0);
  const blocked = skill.blockedByAllowlist || skill.blockedByAgentFilter === true;
  const baseEnabled = !skill.disabled;
  return {
    key: skill.skillKey,
    name: skill.name,
    enabled: baseEnabled && !missingDeps && !blocked,
    baseEnabled,
    ...(missingDeps ? { missingDeps: true } : {}),
    ...(blocked ? { blocked: true } : {}),
  };
}

export class ChatComposerCapabilityHost {
  private readonly skills = new Map<string, ChatComposerMenuSkill[]>();
  private readonly loading = new Set<string>();
  private readonly loadErrors = new Set<string>();
  private readonly patchTokens = new Map<string, symbol>();
  private client: GatewayBrowserClient | null = null;
  private addDialogOpen = false;
  private addScope: ComposerMcpServerScope = "session";
  private addBusy = false;
  private addError: string | null = null;

  constructor(private readonly notify: () => void) {}

  static async addMcpServer(options: {
    scope: ComposerMcpServerScope;
    name: string;
    config: Record<string, unknown>;
    patchGlobal: (
      config: Record<string, unknown>,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    loadSessionOverrides: () => Promise<
      | { ok: true; overrides: SessionToolOverrides | null | undefined }
      | { ok: false; error: string }
    >;
    patchSession: (
      next: SessionToolOverrides,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
  }): Promise<CapabilityMutationResult> {
    const globalConfig =
      options.scope === "session" ? { ...options.config, enabled: false } : options.config;
    let globalResult: Awaited<ReturnType<typeof options.patchGlobal>>;
    try {
      globalResult = await options.patchGlobal(globalConfig);
    } catch (error) {
      return { ok: false, error: errorMessage(error), stage: "config" };
    }
    if (!globalResult.ok) {
      return { ...globalResult, stage: "config" };
    }
    if (options.scope === "everywhere") {
      return { ok: true };
    }
    let loaded: Awaited<ReturnType<typeof options.loadSessionOverrides>>;
    try {
      loaded = await options.loadSessionOverrides();
    } catch (error) {
      return { ok: false, error: errorMessage(error), stage: "session" };
    }
    if (!loaded.ok) {
      return { ...loaded, stage: "session" };
    }
    const next = nextBooleanToolOverrides(
      loaded.overrides,
      "mcpServers",
      options.name,
      true,
      false,
    );
    let sessionResult: Awaited<ReturnType<typeof options.patchSession>>;
    try {
      sessionResult = await options.patchSession(next);
    } catch (error) {
      return { ok: false, error: errorMessage(error), stage: "session" };
    }
    return sessionResult.ok ? sessionResult : { ...sessionResult, stage: "session" };
  }

  private loadSkills(context: ApplicationContext, state: ChatPageHost, agentId: string): void {
    const config = context.runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void context.runtimeConfig.ensureLoaded().catch(() => undefined);
    }
    const client = state.client;
    if (!state.connected || !client || this.skills.has(agentId) || this.loading.has(agentId)) {
      return;
    }
    this.loadErrors.delete(agentId);
    this.loading.add(agentId);
    this.notify();
    void loadSkillStatusReport(client, agentId)
      .then((report) => {
        if (report && state.client === client && this.client === client) {
          this.skills.set(
            agentId,
            report.skills
              .map(toComposerSkill)
              .toSorted((left, right) => left.name.localeCompare(right.name)),
          );
        }
      })
      .catch(() => {
        if (state.client === client && this.client === client) {
          this.loadErrors.add(agentId);
        }
      })
      .finally(() => {
        if (this.client === client) {
          this.loading.delete(agentId);
          this.notify();
        }
      });
  }

  private async patch(
    context: ApplicationContext,
    state: ChatPageHost,
    next: SessionToolOverrides | null,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!state.connected || !state.client) {
      return { ok: false, error: t("chat.composer.menu.offlineBlocked") };
    }
    if (!readGatewayOperatorAccess(context.gateway.snapshot).canWrite) {
      return { ok: false, error: t("chat.composer.menu.readOnlyBlocked") };
    }
    const sessionKey = state.sessionKey;
    if (this.patchTokens.has(sessionKey)) {
      return { ok: false, error: t("chat.composer.menu.savingBlocked") };
    }
    const client = state.client;
    const patchToken = Symbol(sessionKey);
    this.patchTokens.set(sessionKey, patchToken);
    const isCurrentPatch = () =>
      this.client === client &&
      state.client === client &&
      state.sessionKey === sessionKey &&
      this.patchTokens.get(sessionKey) === patchToken;
    if (state.sessionKey === sessionKey) {
      state.lastError = null;
      state.chatError = null;
    }
    this.notify();
    try {
      const result = await patchChatSessionSettings(
        state,
        sessionKey,
        { toolOverrides: next },
        {
          ...scopedAgentParamsForSession(state, sessionKey),
        },
      );
      if (!result) {
        throw new Error(t("chat.composer.menu.offlineBlocked"));
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isCurrentPatch()) {
        try {
          await refreshCurrentChatSessionList(state);
        } catch {
          // The unchanged session row remains authoritative if refresh also fails.
        }
        if (isCurrentPatch()) {
          state.lastError = message;
          state.chatError = message;
          state.requestUpdate?.();
        }
      }
      return { ok: false, error: message };
    } finally {
      if (this.patchTokens.get(sessionKey) === patchToken) {
        this.patchTokens.delete(sessionKey);
        if (this.client === client) {
          this.notify();
        }
      }
    }
  }

  private closeAddDialog(): void {
    if (this.addBusy) {
      return;
    }
    this.addDialogOpen = false;
    this.addError = null;
    this.notify();
  }

  private addServerBlockedReason(
    context: ApplicationContext,
    state: ChatPageHost,
    session: GatewaySessionRow | undefined,
    scope: ComposerMcpServerScope,
  ): string | null {
    const access = readGatewayOperatorAccess(context.gateway.snapshot);
    if (!state.connected || !state.client) {
      return t("chat.composer.menu.offlineBlocked");
    }
    if (!access.canAdmin) {
      return t("chat.composer.menu.adminBlocked");
    }
    if (scope === "everywhere") {
      return null;
    }
    if (!session) {
      return t("common.loading");
    }
    return this.patchTokens.has(state.sessionKey) ? t("chat.composer.menu.savingBlocked") : null;
  }

  private async loadCurrentSessionOverrides(
    state: ChatPageHost,
    sessionKey: string,
    agentId: string | undefined,
  ) {
    const identityMatches = () =>
      state.sessionKey === sessionKey &&
      scopedAgentListParamsForSession(state, sessionKey).agentId === agentId;
    if (!identityMatches()) {
      return { ok: false as const, error: t("mcpServers.sessionChanged") };
    }
    try {
      await refreshCurrentChatSessionList(state);
    } catch (error) {
      return {
        ok: false as const,
        error: errorMessage(error),
      };
    }
    if (!identityMatches()) {
      return { ok: false as const, error: t("mcpServers.sessionChanged") };
    }
    const sessions = state.sessions.state;
    if (sessions.error) {
      return { ok: false as const, error: sessions.error };
    }
    const row = sessions.result?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, sessionKey),
    );
    if (!row || (sessions.agentId ?? undefined) !== agentId) {
      return {
        ok: false as const,
        error: t("mcpServers.sessionUnavailable"),
      };
    }
    return { ok: true as const, overrides: row.toolOverrides };
  }

  private async submitAddServer(
    context: ApplicationContext,
    state: ChatPageHost,
    session: GatewaySessionRow | undefined,
    form: McpServerForm,
  ): Promise<void> {
    if (this.addBusy) {
      return;
    }
    const blockedReason = this.addServerBlockedReason(context, state, session, this.addScope);
    if (blockedReason) {
      this.addError = blockedReason;
      this.notify();
      return;
    }
    const name = form.name.trim();
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      this.addError = t("mcpServers.nameInvalid");
      this.notify();
      return;
    }
    const config = parseMcpTarget(form.target, form.transport);
    if (!config) {
      this.addError = t("mcpServers.targetInvalid");
      this.notify();
      return;
    }
    this.addBusy = true;
    this.addError = null;
    this.notify();
    const sessionKey = state.sessionKey;
    const agentId = scopedAgentListParamsForSession(state, sessionKey).agentId;
    let result: CapabilityMutationResult;
    try {
      result = await ChatComposerCapabilityHost.addMcpServer({
        scope: this.addScope,
        name,
        config,
        patchGlobal: (globalConfig) =>
          patchMcpServers(context.runtimeConfig, {
            buildPatch: (servers) => buildAddMcpServerPatch(servers, name, globalConfig),
            note: `composer connectors: add MCP server ${name}`,
          }),
        loadSessionOverrides: () => this.loadCurrentSessionOverrides(state, sessionKey, agentId),
        patchSession: (next) => this.patch(context, state, next),
      });
    } finally {
      this.addBusy = false;
    }
    if (!result.ok) {
      this.addError =
        result.stage === "session"
          ? t("mcpServers.sessionEnableFailed", { error: result.error })
          : result.error;
      this.notify();
      return;
    }
    this.addDialogOpen = false;
    this.notify();
  }

  renderAddServerDialog(
    context: ApplicationContext,
    state: ChatPageHost,
    session: GatewaySessionRow | undefined,
  ) {
    if (!this.addDialogOpen) {
      return nothing;
    }
    const scopeBlockedReason = this.addServerBlockedReason(context, state, session, "everywhere");
    const submitBlockedReason = this.addServerBlockedReason(context, state, session, this.addScope);
    const title = t("chat.composer.menu.addMcpServerTitle");
    const description = t("chat.composer.menu.addMcpServerDescription");
    const scopeHint = t(
      this.addScope === "session"
        ? "chat.composer.menu.scopeSessionHint"
        : "chat.composer.menu.scopeEverywhereHint",
    );
    return html`
      <openclaw-modal-dialog
        label=${title}
        description=${description}
        @modal-cancel=${(event: Event) => {
          if (this.addBusy) {
            event.preventDefault();
            return;
          }
          this.closeAddDialog();
        }}
      >
        <div class="exec-approval-card mcp-server-dialog">
          <div class="exec-approval-header">
            <div>
              <div class="exec-approval-title">${title}</div>
              <div class="exec-approval-sub">${description}</div>
            </div>
          </div>
          <div class="mcp-server-dialog__scope">
            <span>${t("chat.composer.menu.scopeLabel")}</span>
            ${renderSettingsSegmented({
              value: this.addScope,
              options: [
                { value: "session", label: t("chat.composer.menu.scopeSession") },
                { value: "everywhere", label: t("chat.composer.menu.scopeEverywhere") },
              ],
              ariaLabel: t("chat.composer.menu.scopeLabel"),
              disabled: this.addBusy || scopeBlockedReason !== null,
              onChange: (scope) => {
                this.addScope = scope;
                this.addError = null;
                this.notify();
              },
            })}
            <span class="mcp-server-dialog__scope-hint">${scopeHint}</span>
          </div>
          ${renderMcpServerForm({
            busy: this.addBusy,
            disabled: submitBlockedReason !== null,
            blockedReason: submitBlockedReason,
            autofocus: true,
            onSubmit: (form) => void this.submitAddServer(context, state, session, form),
            onCancel: () => this.closeAddDialog(),
          })}
          ${this.addError
            ? html`<div class="mcp-server-message mcp-server-message--error" role="alert">
                ${this.addError}
              </div>`
            : nothing}
        </div>
      </openclaw-modal-dialog>
    `;
  }

  props(
    context: ApplicationContext,
    state: ChatPageHost,
    session: GatewaySessionRow | undefined,
    agentId: string,
  ): CapabilityMenuProps {
    if (this.client !== state.client) {
      this.client = state.client;
      this.skills.clear();
      this.loading.clear();
      this.loadErrors.clear();
      this.patchTokens.clear();
    }
    // Sparse session overrides resolve against active runtime defaults, so display and key
    // removal decisions must use the same runtime snapshot that executes the session.
    const runtimeConfig = context.runtimeConfig.state.configSnapshot?.runtimeConfig ?? null;
    const access = readGatewayOperatorAccess(context.gateway.snapshot);
    const gatewayAvailable = state.connected && Boolean(state.client);
    const capabilitiesReady = gatewayAvailable && session !== undefined && runtimeConfig !== null;
    const mutationBlockedReason = !gatewayAvailable
      ? t("chat.composer.menu.offlineBlocked")
      : !capabilitiesReady
        ? t("common.loading")
        : !access.canWrite
          ? t("chat.composer.menu.readOnlyBlocked")
          : this.patchTokens.has(state.sessionKey)
            ? t("chat.composer.menu.savingBlocked")
            : null;
    const adminBlockedReason = !gatewayAvailable
      ? t("chat.composer.menu.offlineBlocked")
      : !access.canAdmin
        ? t("chat.composer.menu.adminBlocked")
        : null;
    return {
      basePath: state.basePath,
      skills:
        this.skills.get(agentId)?.map((skill) =>
          Object.assign({}, skill, {
            enabled:
              skill.missingDeps || skill.blocked
                ? false
                : (session?.toolOverrides?.skills?.[skill.key] ?? skill.baseEnabled),
          }),
        ) ?? null,
      skillsLoading: this.loading.has(agentId),
      skillsError: this.loadErrors.has(agentId),
      mcpServers: summarizeMcpServers(runtimeConfig) ?? [],
      webSearchBaseEnabled: webSearchBaseEnabled(runtimeConfig),
      mutationBlockedReason,
      canAdmin: access.canAdmin && gatewayAvailable,
      adminBlockedReason,
      addServerDialog: this.renderAddServerDialog(context, state, session),
      onLoadSkills: () => this.loadSkills(context, state, agentId),
      onPatchToolOverrides: (next) => void this.patch(context, state, next),
      onNavigate: (routeId, options) => context.navigate(routeId, options),
      onAddServer: () => {
        if (!access.canAdmin || !gatewayAvailable) {
          return;
        }
        this.addDialogOpen = true;
        this.addScope = "session";
        this.addError = null;
        this.notify();
      },
    };
  }
}
