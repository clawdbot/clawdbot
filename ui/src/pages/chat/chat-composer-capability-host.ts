import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SkillStatusEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { summarizeMcpServers } from "../../lib/config/mcp-servers.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
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

  constructor(private readonly notify: () => void) {}

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

  private patch(
    context: ApplicationContext,
    state: ChatPageHost,
    next: SessionToolOverrides | null,
  ): void {
    if (
      !state.connected ||
      !state.client ||
      !readGatewayOperatorAccess(context.gateway.snapshot).canWrite ||
      this.patchTokens.has(state.sessionKey)
    ) {
      return;
    }
    const sessionKey = state.sessionKey;
    const client = state.client;
    const patchToken = Symbol(sessionKey);
    this.patchTokens.set(sessionKey, patchToken);
    const isCurrentPatch = () =>
      this.client === client &&
      state.client === client &&
      state.sessionKey === sessionKey &&
      this.patchTokens.get(sessionKey) === patchToken;
    state.lastError = null;
    state.chatError = null;
    this.notify();
    void patchChatSessionSettings(
      state,
      sessionKey,
      { toolOverrides: next },
      {
        ...scopedAgentParamsForSession(state, sessionKey),
      },
    )
      .catch(async (error: unknown) => {
        if (!isCurrentPatch()) {
          return;
        }
        try {
          await refreshCurrentChatSessionList(state);
        } catch {
          // The unchanged session row remains authoritative if refresh also fails.
        }
        if (!isCurrentPatch()) {
          return;
        }
        state.lastError = error instanceof Error ? error.message : String(error);
        state.chatError = state.lastError;
        state.requestUpdate?.();
      })
      .finally(() => {
        if (this.patchTokens.get(sessionKey) === patchToken) {
          this.patchTokens.delete(sessionKey);
          if (this.client === client) {
            this.notify();
          }
        }
      });
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
      onLoadSkills: () => this.loadSkills(context, state, agentId),
      onPatchToolOverrides: (next) => this.patch(context, state, next),
      onNavigate: (routeId, options) => context.navigate(routeId, options),
    };
  }
}
