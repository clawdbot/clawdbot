import type { TopLevelComponents } from "./internal/discord.js";

export type DiscordComponentButtonStyle = "primary" | "secondary" | "success" | "danger" | "link";

export type DiscordComponentSelectType = "string" | "user" | "role" | "mentionable" | "channel";

export type DiscordComponentModalFieldType =
  | "text"
  | "checkbox"
  | "radio"
  | "select"
  | "role-select"
  | "user-select";

export type DiscordComponentButtonSpec = {
  label: string;
  style?: DiscordComponentButtonStyle;
  url?: string;
  callbackData?: string;
  /** Internal use only: bypass dynamic component ids with a fixed custom id. */
  internalCustomId?: string;
  emoji?: {
    name: string;
    id?: string;
    animated?: boolean;
  };
  disabled?: boolean;
  /** Optional allowlist of users who can interact with this button (ids or names). */
  allowedUsers?: string[];
};

export type DiscordComponentSelectOption = {
  label: string;
  value: string;
  description?: string;
  emoji?: {
    name: string;
    id?: string;
    animated?: boolean;
  };
  default?: boolean;
};

export type DiscordComponentSelectSpec = {
  type?: DiscordComponentSelectType;
  callbackData?: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  options?: DiscordComponentSelectOption[];
  allowedUsers?: string[];
};

export type DiscordComponentSectionAccessory =
  | {
      type: "thumbnail";
      url: string;
    }
  | {
      type: "button";
      button: DiscordComponentButtonSpec;
    };

type DiscordComponentSeparatorSpacing = "small" | "large" | 1 | 2;

export type DiscordComponentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "section";
      text?: string;
      texts?: string[];
      accessory?: DiscordComponentSectionAccessory;
    }
  | {
      type: "separator";
      spacing?: DiscordComponentSeparatorSpacing;
      divider?: boolean;
    }
  | {
      type: "actions";
      buttons?: DiscordComponentButtonSpec[];
      select?: DiscordComponentSelectSpec;
    }
  | {
      type: "media-gallery";
      items: Array<{ url: string; description?: string; spoiler?: boolean }>;
    }
  | {
      type: "file";
      file: `attachment://${string}`;
      spoiler?: boolean;
    };

export type DiscordModalFieldSpec = {
  type: DiscordComponentModalFieldType;
  name?: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: DiscordComponentSelectOption[];
  minValues?: number;
  maxValues?: number;
  minLength?: number;
  maxLength?: number;
  style?: "short" | "paragraph";
};

export type DiscordComponentModalFieldSpec = DiscordModalFieldSpec;

export type DiscordModalSpec = {
  title: string;
  callbackData?: string;
  triggerLabel?: string;
  triggerStyle?: DiscordComponentButtonStyle;
  allowedUsers?: string[];
  fields: DiscordModalFieldSpec[];
};

export type DiscordComponentMessageSpec = {
  text?: string;
  reusable?: boolean;
  container?: {
    accentColor?: string | number;
    spoiler?: boolean;
  };
  blocks?: DiscordComponentBlock[];
  modal?: DiscordModalSpec;
};

export type DiscordComponentEntry = {
  id: string;
  kind: "button" | "select" | "modal-trigger";
  label: string;
  callbackData?: string;
  selectType?: DiscordComponentSelectType;
  options?: Array<{ value: string; label: string }>;
  modalId?: string;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  reusable?: boolean;
  allowedUsers?: string[];
  messageId?: string;
  createdAt?: number;
  expiresAt?: number;
};

export type DiscordModalFieldDefinition = {
  id: string;
  name: string;
  label: string;
  type: DiscordComponentModalFieldType;
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: DiscordComponentSelectOption[];
  minValues?: number;
  maxValues?: number;
  minLength?: number;
  maxLength?: number;
  style?: "short" | "paragraph";
};

export type DiscordComponentModalFieldDefinition = DiscordModalFieldDefinition;

export type DiscordModalEntry = {
  id: string;
  title: string;
  callbackData?: string;
  fields: DiscordModalFieldDefinition[];
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  reusable?: boolean;
  messageId?: string;
  createdAt?: number;
  expiresAt?: number;
  allowedUsers?: string[];
};

export type DiscordComponentModalEntry = DiscordModalEntry;

export type DiscordComponentBuildResult = {
  components: TopLevelComponents[];
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
};
