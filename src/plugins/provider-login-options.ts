import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { compareProviderAuthChoiceGroups } from "./provider-auth-choice-order.js";
import {
  resolveManifestDeclaredProviderAuthChoices,
  resolveManifestProviderAuthChoices,
  type ProviderAuthChoiceMetadata,
} from "./provider-auth-choices.js";

export type ProviderLoginOption = {
  id: string;
  brandId?: string;
  label: string;
  hint?: string;
  groupLabel?: string;
  icon?: string;
  website?: string;
  kind: "oauth" | "device-code" | "secret";
  featured: boolean;
};

export type ProviderAccessOption = Omit<ProviderLoginOption, "kind"> & {
  actionLabel?: string;
  kind: ProviderLoginOption["kind"] | "setup";
  mode: "login" | "setup";
};

export type ProviderChannelLoginChoice = {
  choiceId: string;
  pluginId: string;
  providerId: string;
  methodId: string;
  label: string;
  providerLabel: string;
  command: string;
  mode: "chat" | "secret" | "setup" | "sign-in";
};

export type ProviderChannelLoginResolution =
  | { status: "resolved"; choice: ProviderChannelLoginChoice }
  | {
      status: "ambiguous" | "unsupported";
      choices: ProviderChannelLoginChoice[];
    };

export function supportsProviderAuthChoiceTextInference(
  scopes?: ProviderAuthChoiceMetadata["onboardingScopes"],
): boolean {
  return !scopes || scopes.includes("text-inference");
}

function isProviderLoginSurfaceEligible(choice: ProviderAuthChoiceMetadata): boolean {
  return (
    choice.choiceId.trim().length > 0 &&
    supportsProviderAuthChoiceTextInference(choice.onboardingScopes) &&
    choice.assistantVisibility !== "manual-only"
  );
}

function toProviderLoginOption(
  choice: ProviderAuthChoiceMetadata,
): ProviderLoginOption | undefined {
  const id = choice.choiceId.trim();
  const kind =
    choice.appGuidedAuth ??
    (choice.appGuidedSecret === true && choice.appGuidedDiscovery !== true ? "secret" : undefined);
  if (!isProviderLoginSurfaceEligible(choice) || !kind) {
    return undefined;
  }
  return {
    id,
    brandId: choice.providerId,
    label: choice.choiceLabel,
    ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
    ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
    ...(choice.icon ? { icon: choice.icon } : {}),
    ...(choice.website ? { website: choice.website } : {}),
    kind,
    featured: choice.onboardingFeatured === true,
  };
}

export function listProviderLoginOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): ProviderLoginOption[] {
  const choiceIdCounts = new Map<string, number>();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (id) {
      choiceIdCounts.set(id, (choiceIdCounts.get(id) ?? 0) + 1);
    }
  }
  const choices = new Map<
    string,
    { metadata: ProviderAuthChoiceMetadata; option: ProviderLoginOption }
  >();
  for (const choice of authChoices) {
    const option = toProviderLoginOption(choice);
    if (!option || choiceIdCounts.get(option.id) !== 1) {
      continue;
    }
    choices.set(option.id, { metadata: choice, option });
  }
  return [...choices.values()]
    .toSorted(
      (a, b) =>
        Number(b.option.featured) - Number(a.option.featured) ||
        compareProviderAuthChoiceGroups(
          {
            id: a.metadata.groupId ?? a.metadata.providerId,
            label: a.metadata.groupLabel ?? a.metadata.choiceLabel,
          },
          {
            id: b.metadata.groupId ?? b.metadata.providerId,
            label: b.metadata.groupLabel ?? b.metadata.choiceLabel,
          },
        ) ||
        (a.metadata.assistantPriority ?? 0) - (b.metadata.assistantPriority ?? 0) ||
        a.option.label.localeCompare(b.option.label, "en") ||
        a.option.id.localeCompare(b.option.id, "en"),
    )
    .map(({ option }) => option);
}

function toProviderSetupOption(
  choice: ProviderAuthChoiceMetadata,
): ProviderAccessOption | undefined {
  const id = choice.choiceId.trim();
  if (!isProviderLoginSurfaceEligible(choice)) {
    return undefined;
  }
  return {
    id,
    brandId: choice.providerId,
    label: choice.choiceLabel,
    ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
    ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
    ...(choice.icon ? { icon: choice.icon } : {}),
    ...(choice.website ? { website: choice.website } : {}),
    ...(choice.appGuidedActionLabel?.trim()
      ? { actionLabel: choice.appGuidedActionLabel.trim() }
      : {}),
    kind: "setup",
    mode: "setup",
    featured: choice.onboardingFeatured === true,
  };
}

export function listProviderAccessOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): ProviderAccessOption[] {
  const choiceIdCounts = new Map<string, number>();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (id) {
      choiceIdCounts.set(id, (choiceIdCounts.get(id) ?? 0) + 1);
    }
  }
  const unambiguousChoices = authChoices.filter(
    (choice) => choiceIdCounts.get(choice.choiceId.trim()) === 1,
  );
  const loginById = new Map(
    listProviderLoginOptions(unambiguousChoices).map((option) => [option.id, option] as const),
  );
  return unambiguousChoices
    .flatMap((choice) => {
      const login = loginById.get(choice.choiceId);
      const option = login ? { ...login, mode: "login" as const } : toProviderSetupOption(choice);
      return option ? [{ metadata: choice, option }] : [];
    })
    .toSorted(
      (a, b) =>
        Number(b.option.featured) - Number(a.option.featured) ||
        compareProviderAuthChoiceGroups(
          {
            id: a.metadata.groupId ?? a.metadata.providerId,
            label: a.metadata.groupLabel ?? a.metadata.choiceLabel,
          },
          {
            id: b.metadata.groupId ?? b.metadata.providerId,
            label: b.metadata.groupLabel ?? b.metadata.choiceLabel,
          },
        ) ||
        (a.metadata.assistantPriority ?? 0) - (b.metadata.assistantPriority ?? 0) ||
        a.option.label.localeCompare(b.option.label, "en") ||
        a.option.id.localeCompare(b.option.id, "en"),
    )
    .map(({ option }) => option);
}

function normalizeLoginInput(value: string | undefined): string {
  return normalizeLowercaseStringOrEmpty(value ?? "").replace(/_/gu, "-");
}

function channelLoginChoiceKey(
  choice: Pick<ProviderChannelLoginChoice, "pluginId" | "choiceId" | "providerId" | "methodId">,
): string {
  return `${choice.pluginId}\0${choice.choiceId}\0${choice.providerId}\0${choice.methodId}`;
}

function uniqueChoices(choices: readonly ProviderChannelLoginChoice[]) {
  return [...new Map(choices.map((choice) => [channelLoginChoiceKey(choice), choice])).values()];
}

function readProviderChannelLoginMetadata(
  params?: Parameters<typeof resolveManifestProviderAuthChoices>[0],
): ProviderAuthChoiceMetadata[] {
  const choices = resolveManifestDeclaredProviderAuthChoices({
    ...params,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  });
  return choices.filter(isProviderLoginSurfaceEligible);
}

function projectProviderChannelLoginChoices(
  metadata: readonly ProviderAuthChoiceMetadata[],
): ProviderChannelLoginChoice[] {
  const providerCounts = new Map<string, number>();
  const directProviderCounts = new Map<string, number>();
  for (const choice of metadata) {
    const provider = normalizeLoginInput(choice.providerId);
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
    if (choice.channelLogin) {
      directProviderCounts.set(provider, (directProviderCounts.get(provider) ?? 0) + 1);
    }
  }
  return metadata
    .map((choice): ProviderChannelLoginChoice => {
      const firstAlias = choice.channelLogin?.aliases?.[0];
      const provider = normalizeLoginInput(choice.providerId);
      const login = toProviderLoginOption(choice);
      return {
        choiceId: choice.choiceId,
        pluginId: choice.pluginId,
        providerId: choice.providerId,
        methodId: choice.methodId,
        label: choice.choiceLabel,
        providerLabel: choice.groupLabel?.trim() || choice.choiceLabel,
        command:
          firstAlias ??
          ((choice.channelLogin && (directProviderCounts.get(provider) ?? 0) === 1) ||
          (providerCounts.get(provider) ?? 0) === 1
            ? choice.providerId
            : choice.choiceId),
        mode: choice.channelLogin
          ? "chat"
          : login?.kind === "secret"
            ? "secret"
            : login
              ? "sign-in"
              : "setup",
      };
    })
    .toSorted(
      (a, b) => a.label.localeCompare(b.label, "en") || a.choiceId.localeCompare(b.choiceId),
    );
}

export function listProviderChannelLoginChoices(
  params?: Parameters<typeof resolveManifestProviderAuthChoices>[0],
): ProviderChannelLoginChoice[] {
  return projectProviderChannelLoginChoices(readProviderChannelLoginMetadata(params));
}

export function resolveProviderChannelLoginChoice(
  input: string | undefined,
  params?: Parameters<typeof resolveManifestProviderAuthChoices>[0],
): ProviderChannelLoginResolution {
  const metadata = readProviderChannelLoginMetadata(params);
  const choices = projectProviderChannelLoginChoices(metadata);
  const projectedByOwner = new Map(
    choices.map((choice) => [channelLoginChoiceKey(choice), choice]),
  );
  const normalized = normalizeLoginInput(input);
  const select = (matches: readonly ProviderAuthChoiceMetadata[]) => {
    const resolved = uniqueChoices(
      matches.flatMap((choice) => {
        const projected = projectedByOwner.get(channelLoginChoiceKey(choice));
        return projected ? [projected] : [];
      }),
    ).toSorted(
      (a, b) => a.label.localeCompare(b.label, "en") || a.choiceId.localeCompare(b.choiceId),
    );
    return resolved.length === 1
      ? ({ status: "resolved", choice: resolved[0]! } as const)
      : ({ status: "ambiguous", choices: resolved.length > 0 ? resolved : choices } as const);
  };
  if (!normalized) {
    const defaults = metadata.filter((choice) => choice.channelLogin?.default === true);
    return defaults.length > 0 ? select(defaults) : { status: "unsupported", choices };
  }
  const exactChoices = metadata.filter(
    (choice) => normalizeLoginInput(choice.choiceId) === normalized,
  );
  if (exactChoices.length > 0) {
    return select(exactChoices);
  }
  const providerOrGroup = metadata.filter(
    (choice) =>
      normalizeLoginInput(choice.providerId) === normalized ||
      normalizeLoginInput(choice.groupId) === normalized,
  );
  if (providerOrGroup.length > 0) {
    const direct = providerOrGroup.filter((choice) => choice.channelLogin);
    return select(direct.length > 0 ? direct : providerOrGroup);
  }
  const aliases = metadata.filter((choice) =>
    choice.channelLogin?.aliases?.some((alias) => normalizeLoginInput(alias) === normalized),
  );
  return aliases.length > 0 ? select(aliases) : { status: "unsupported", choices };
}
