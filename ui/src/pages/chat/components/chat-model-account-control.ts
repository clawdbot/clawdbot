import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type {
  ChatAccountSelection,
  UserModelAccount,
  UsersListModelAccountsResult,
} from "../../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { icons } from "../../../components/icons.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import { formatUiError } from "../../../lib/format-error.ts";

type AccountInventory = {
  model: string;
  selection: ChatAccountSelection;
  accounts: UserModelAccount[];
  nextCursor?: string;
  loading: boolean;
  error: string | null;
  isCurrent: () => boolean;
};

const inventories = new WeakMap<object, AccountInventory>();

export function renderChatModelAccountControl(params: {
  owner: object;
  client: GatewayBrowserClient | null | undefined;
  selection: ChatAccountSelection | null | undefined;
  model: string;
  disabled: boolean;
  ownsSelection: () => boolean;
  onSelect: (account: UserModelAccount) => Promise<boolean>;
  onAutomatic?: () => void;
  onManage?: () => void;
  onRequestUpdate: () => void;
  hint?: string;
}) {
  const { owner, selection, client } = params;
  if (!selection) {
    return nothing;
  }
  let inventory = inventories.get(owner);
  if (
    !inventory?.isCurrent() ||
    inventory.model !== params.model ||
    inventory.selection !== selection
  ) {
    inventory = {
      model: params.model,
      selection,
      accounts: [],
      loading: false,
      error: null,
      isCurrent: params.ownsSelection,
    };
    inventories.set(owner, inventory);
  }
  const currentInventory = inventory;
  const ownsInventory = () =>
    inventories.get(owner) === currentInventory && currentInventory.isCurrent();
  const loadAccounts = async (cursor?: string) => {
    if (!client || !ownsInventory() || currentInventory.loading) {
      return;
    }
    currentInventory.loading = true;
    currentInventory.error = null;
    params.onRequestUpdate();
    try {
      const result = await client.request<UsersListModelAccountsResult>(
        "users.listModelAccounts",
        cursor ? { cursor } : {},
      );
      if (ownsInventory()) {
        currentInventory.accounts = cursor
          ? [...currentInventory.accounts, ...result.accounts]
          : result.accounts;
        currentInventory.nextCursor = result.nextCursor;
      }
    } catch (error) {
      if (ownsInventory()) {
        currentInventory.error = formatUiError(
          error,
          t("profilePage.modelAccounts.inventoryFailed"),
        );
      }
    } finally {
      if (ownsInventory()) {
        currentInventory.loading = false;
        params.onRequestUpdate();
      }
    }
  };
  const provider = params.model.includes("/")
    ? normalizeChatModelProviderId(params.model.slice(0, params.model.indexOf("/")))
    : "";
  const currentId = selection.kind === "automatic" ? undefined : selection.authProfileId;
  const description = (account: UserModelAccount | undefined) =>
    account &&
    currentInventory.accounts.some(
      (candidate) =>
        candidate.authProfileId !== account.authProfileId &&
        candidate.provider === account.provider &&
        candidate.label === account.label,
    )
      ? account.authProfileId
      : undefined;
  const currentValue = "current";
  const options: Array<{ value: string; label: string; description?: string; disabled?: boolean }> =
    [
      {
        value: currentValue,
        label: selection.label,
        description: description(
          currentInventory.accounts.find((account) => account.authProfileId === currentId),
        ),
      },
      ...currentInventory.accounts
        .filter((account) => account.provider === provider && account.authProfileId !== currentId)
        .map((account) => ({
          value: `account:${account.authProfileId}`,
          label: account.label,
          description: description(account),
        })),
      ...(params.onAutomatic
        ? [{ value: "automatic", label: t("chat.modelAccounts.automatic") }]
        : []),
      ...(currentInventory.loading
        ? [{ value: "loading", label: t("common.loading"), disabled: true }]
        : []),
      ...(currentInventory.nextCursor
        ? [{ value: "more", label: t("profilePage.modelAccounts.loadMore") }]
        : []),
      ...(params.onManage ? [{ value: "manage", label: t("chat.modelAccounts.manage") }] : []),
    ];
  const selectAccount = (event: CustomEvent<{ item: { value: string } }>) => {
    if (!ownsInventory() || params.disabled) {
      return;
    }
    const value = event.detail.item.value;
    if (value === "manage") {
      params.onManage?.();
    } else if (value === "automatic") {
      params.onAutomatic?.();
    } else if (value === "more") {
      event.preventDefault();
      void loadAccounts(currentInventory.nextCursor);
    } else {
      const account = currentInventory.accounts.find(
        (candidate) =>
          `account:${candidate.authProfileId}` === value && candidate.provider === provider,
      );
      if (account) {
        void params.onSelect(account);
      }
    }
  };
  return html`
    <div
      class="chat-model-account chat-controls__model-provenance"
      data-chat-account-selection=${selection.kind}
    >
      <span>${t("chat.modelAccounts.label")}</span>
      <wa-dropdown
        class="chat-model-account__picker"
        placement="top-start"
        aria-label=${t("chat.modelAccounts.label")}
        @wa-show=${() => void loadAccounts()}
        @wa-select=${selectAccount}
      >
        <button
          slot="trigger"
          type="button"
          class="chat-controls__inline-select-trigger"
          data-chat-account-trigger
          aria-label=${`${t("chat.modelAccounts.label")}: ${selection.label}`}
          ?disabled=${params.disabled}
        >
          <span class="chat-controls__inline-select-label">${selection.label}</span>
          <span class="chat-controls__inline-select-chevron" aria-hidden="true"
            >${icons.chevronDown}</span
          >
        </button>
        ${options.map(
          (option) => html`
            <wa-dropdown-item
              .value=${option.value}
              data-chat-account-option=${option.value}
              ?disabled=${option.disabled || params.disabled}
              ${ref((element) => {
                if (option.value === currentValue || option.value.startsWith("account:")) {
                  syncDropdownItemRadio(element, option.value === currentValue);
                }
              })}
            >
              <span
                >${option.label}${
                  option.description ? html`<br /><small>${option.description}</small>` : nothing
                }</span
              >
            </wa-dropdown-item>
          `,
        )}
      </wa-dropdown>
      <span class="chat-model-account__hint">${params.hint ?? t("chat.modelAccounts.hint")}</span>
      ${
        currentInventory.error
          ? html`<span class="chat-model-account__error" role="alert"
              >${currentInventory.error}</span
            >`
          : nothing
      }
    </div>
  `;
}
