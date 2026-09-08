import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enModelAccounts = {
  profilePage: {
    modelAccounts: {
      title: "Connected accounts",
      addAccount: "Add account",
      provider: "Provider",
      method: "Sign-in method",
      noMethods: "No personal sign-in methods are available. Ask your administrator for help.",
      gateway: "Gateway",
      gatewayUnavailable: "Endpoint unavailable",
      person: "Person",
      currentPerson: "Current person",
      noPerson: "Not identified",
      scope: "Scope",
      personal: "Personal",
      personalDescription:
        "Sign-in saves an account for this person on this Gateway. System and agent credentials are unchanged.",
      signInUnavailable: "Sign-in not ready",
      connectionSettings: "Connection settings",
      unavailable: {
        identity:
          "Use the identity-enabled Gateway address supplied by your administrator, through Tailscale Serve or a trusted proxy. A shared token or device pairing alone does not identify a person.",
        write:
          "Personal account sign-in requires operator.write access. Ask your administrator for access, then reconnect to the Gateway.",
        profile:
          "Wait for your identity profile to load. If it does not appear, use Refresh or Set identity above to retry.",
      },
      description:
        "Choose the account new chats prefer. Existing chats keep their account choice. Gateway fallback rules still apply; this preference is not a billing guarantee.",
      empty: "No personal default selected. New chats use the gateway's default account.",
      linkedDescription:
        "Preferred for new chats with this provider. Clearing the default keeps the saved credential and existing chat choices.",
      linkedStatus: "New chat default",
      gatewayAccount: "Selected saved account",
      selectAction: "Use for new chats",
      savedAccounts: "Saved accounts",
      loadMore: "Load more saved accounts",
      inventoryFailed: "Could not load saved accounts. Refresh to retry.",
      authTypes: {
        oauth: "Browser sign-in · saved account",
        token: "Token · saved account",
        api_key: "API key · saved account",
      },
      checkStatusAction: "Check status",
      actionFailed: "Could not update connected accounts. Try again.",
      statusFailed: "Could not check sign-in status. Check again or cancel this attempt.",
      statusTimedOut: "Sign-in has not finished. Check its status or cancel and sign in again.",
      notices: {
        connected: "Account added.",
        cancelled: "Sign-in cancelled. No account was added by this attempt.",
        expired: "Sign-in expired. Sign in again to start a new attempt.",
        selected: "Default updated for new chats. Existing chats are unchanged.",
        cleared:
          "New chats use the gateway default for this provider. Saved credentials and existing chats are unchanged.",
      },
      connectErrors: {
        exchange: "Sign-in failed while exchanging the authorization code. Sign in again.",
        identity:
          "The account identity could not be verified. Sign in again with your own account.",
        authority:
          "Your access changed before sign-in finished. Reconnect to the gateway and try again.",
        unavailable:
          "The gateway could not save the account. Sign in again or ask an administrator for help.",
      },
      inputLabel: "Use an existing gateway credential",
      inputDescription:
        "Admin only: choose an existing Gateway credential for this person's new chats. This does not sign in or change the stored credential.",
      inputPlaceholder: "openai:alice",
      linkAction: "Use for new chats",
      unlinkAction: "Use gateway default",
      connectAction: "Sign in",
      cancelAction: "Cancel",
    },
  },
} satisfies TranslationMap;

export const registerModelAccountsEnglish = Object.assign(
  () => {
    // Account surfaces load this copy lazily; shared profile navigation stays eager.
    en.profilePage = Object.assign({}, en.profilePage, enModelAccounts.profilePage);
  },
  { catalog: enModelAccounts },
);
