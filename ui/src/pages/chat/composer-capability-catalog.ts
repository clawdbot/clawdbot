import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusEntry } from "../../api/types.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { readOwnEntry } from "../../lib/sessions/tool-overrides.ts";
import { loadSkillStatusReport } from "../../lib/skills/status-report.ts";
import type { ChatComposerMenuSkill } from "./components/chat-composer-plus-menu.ts";

export function composerWebSearchBaseEnabled(config: Record<string, unknown> | null): boolean {
  return asRecord(asRecord(asRecord(config?.tools)?.web)?.search)?.enabled !== false;
}

function toComposerSkill(skill: SkillStatusEntry): ChatComposerMenuSkill {
  const missingDeps = Object.values(skill.missing).some((values) => values.length > 0);
  const blocked = skill.blockedByAllowlist || skill.blockedByAgentFilter;
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

export class ComposerSkillCatalog {
  private readonly skills = new Map<string, ChatComposerMenuSkill[]>();
  private readonly loading = new Set<string>();
  private readonly loadErrors = new Set<string>();
  private client: GatewayBrowserClient | null = null;
  private connectionEpoch: number | undefined;

  constructor(private readonly notify: () => void) {}

  synchronize(client: GatewayBrowserClient | null, connectionEpoch: number | undefined) {
    if (this.client === client && this.connectionEpoch === connectionEpoch) {
      return;
    }
    this.client = client;
    this.connectionEpoch = connectionEpoch;
    this.skills.clear();
    this.loading.clear();
    this.loadErrors.clear();
  }

  load(
    client: GatewayBrowserClient | null,
    connectionEpoch: number | undefined,
    agentId: string,
    isCurrentConnection: () => boolean,
  ): void {
    this.synchronize(client, connectionEpoch);
    if (
      !client ||
      !isCurrentConnection() ||
      this.skills.has(agentId) ||
      this.loading.has(agentId)
    ) {
      return;
    }
    const isCurrent = () =>
      this.client === client && this.connectionEpoch === connectionEpoch && isCurrentConnection();
    this.loadErrors.delete(agentId);
    this.loading.add(agentId);
    this.notify();
    void loadSkillStatusReport(client, agentId)
      .then((report) => {
        if (report && isCurrent()) {
          this.skills.set(
            agentId,
            report.skills
              .map(toComposerSkill)
              .toSorted((left, right) => left.name.localeCompare(right.name)),
          );
        }
      })
      .catch(() => {
        if (isCurrent()) {
          this.loadErrors.add(agentId);
        }
      })
      .finally(() => {
        if (isCurrent()) {
          this.loading.delete(agentId);
          this.notify();
        }
      });
  }

  rows(agentId: string, toolOverrides: SessionToolOverrides | null | undefined) {
    return (
      this.skills.get(agentId)?.map((skill) =>
        Object.assign({}, skill, {
          enabled:
            skill.missingDeps || skill.blocked
              ? false
              : (readOwnEntry(toolOverrides?.skills, skill.key) ?? skill.baseEnabled),
        }),
      ) ?? null
    );
  }

  isLoading(agentId: string): boolean {
    return this.loading.has(agentId);
  }

  hasError(agentId: string): boolean {
    return this.loadErrors.has(agentId);
  }
}
