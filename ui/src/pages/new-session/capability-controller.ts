import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { summarizeMcpServers } from "../../lib/config/mcp-servers.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { countSessionToolOverrides } from "../../lib/sessions/tool-overrides.ts";
import type { CapabilityMenuProps } from "../chat/components/chat-composer-types.ts";
import {
  ComposerSkillCatalog,
  composerWebSearchBaseEnabled,
} from "../chat/composer-capability-catalog.ts";
import { canStartSessionAsDraft } from "./create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";

export class NewSessionCapabilityController {
  private readonly skillCatalog: ComposerSkillCatalog;
  private toolOverridesValue: SessionToolOverrides | null = null;
  private onMutation = () => {};

  constructor(private readonly notify: () => void) {
    this.skillCatalog = new ComposerSkillCatalog(notify);
  }

  setMutationCallback(onMutation: () => void) {
    this.onMutation = onMutation;
  }

  get toolOverrides(): SessionToolOverrides | null {
    return this.toolOverridesValue;
  }

  setToolOverrides(toolOverrides: SessionToolOverrides | null) {
    const next = countSessionToolOverrides(toolOverrides) > 0 ? toolOverrides : null;
    if (next === this.toolOverridesValue) {
      return;
    }
    this.onMutation();
    this.toolOverridesValue = next;
    this.notify();
  }

  reset() {
    this.toolOverridesValue = null;
  }

  restoreToolOverrides(toolOverrides: SessionToolOverrides | null | undefined) {
    if (toolOverrides !== undefined) {
      this.setToolOverrides(toolOverrides);
    }
  }

  canStartAsDraft(context: ApplicationContext | undefined): boolean {
    return canStartSessionAsDraft({
      allowedVisibilities: context?.gateway.snapshot.hello?.policy?.allowedSessionVisibilities,
      hasMultipleIdentities:
        context?.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities,
    });
  }

  composerProps(
    context: ApplicationContext | undefined,
    gateway: DraftGatewayState,
    agentId: string,
  ) {
    return {
      toolOverrides: this.toolOverridesValue,
      capabilityMenu: context ? this.props(context, gateway, agentId) : undefined,
    };
  }

  props(
    context: ApplicationContext,
    gateway: DraftGatewayState,
    agentId: string,
  ): CapabilityMenuProps {
    this.skillCatalog.synchronize(gateway.client, gateway.connectionEpoch);
    const config = context.runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void context.runtimeConfig.ensureLoaded().finally(this.notify);
    }
    const runtimeConfig = config.configSnapshot?.runtimeConfig ?? null;
    const gatewayAvailable = gateway.connected && Boolean(gateway.client);
    const access = readGatewayOperatorAccess(context.gateway.snapshot);
    const mutationBlockedReason = !gatewayAvailable
      ? t("chat.composer.menu.offlineBlocked")
      : !runtimeConfig
        ? t("common.loading")
        : !access.canAdmin
          ? t("chat.composer.menu.adminBlocked")
          : null;
    return {
      basePath: context.basePath,
      skills: this.skillCatalog.rows(agentId, this.toolOverridesValue),
      skillsLoading: this.skillCatalog.isLoading(agentId),
      skillsError: this.skillCatalog.hasError(agentId),
      mcpServers: summarizeMcpServers(runtimeConfig) ?? [],
      toolsEffectiveResult: null,
      toolsEffectiveLoading: false,
      toolsEffectiveError: false,
      toolAccessMutationBlockedReason: mutationBlockedReason,
      webSearchBaseEnabled: composerWebSearchBaseEnabled(runtimeConfig),
      mutationBlockedReason,
      canAdmin: access.canAdmin && gatewayAvailable,
      adminBlockedReason: access.canAdmin
        ? gatewayAvailable
          ? null
          : t("chat.composer.menu.offlineBlocked")
        : t("chat.composer.menu.adminBlocked"),
      onLoadSkills: () => {
        const client = gateway.client;
        const connectionEpoch = gateway.connectionEpoch;
        this.skillCatalog.load(
          client,
          connectionEpoch,
          agentId,
          () =>
            gateway.connected &&
            gateway.client === client &&
            gateway.connectionEpoch === connectionEpoch,
        );
      },
      onPatchToolOverrides: (next) => this.setToolOverrides(next),
      onNavigate: (routeId, options) => context.navigate(routeId, options),
    };
  }
}
