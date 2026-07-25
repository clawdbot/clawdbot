import path from "node:path";

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_REGISTERED_ITEMS = 32;
const MAX_DESCRIPTION_LENGTH = 200;

export type OnePasswordPolicy = "auto" | "approve" | "deny";

export type OnePasswordItemConfig = {
  item: string;
  vault: string;
  field: string;
  policy: OnePasswordPolicy;
  description?: string;
};

export type OnePasswordConfig = {
  vault: string;
  opBin?: string;
  defaultPolicy: OnePasswordPolicy;
  cacheTtlSeconds: number;
  grantTtlHours: number;
  opTimeoutMs: number;
  items: Record<string, OnePasswordItemConfig>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`1Password config ${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`1Password config ${key} must be a non-empty string`);
  }
  return value.trim();
}

function readPolicy(value: unknown, label: string, fallback: OnePasswordPolicy): OnePasswordPolicy {
  if (value === undefined) {
    return fallback;
  }
  if (value === "auto" || value === "approve" || value === "deny") {
    return value;
  }
  throw new Error(`1Password config ${label} must be auto, approve, or deny`);
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  options: { integer: boolean; allowZero: boolean },
): number {
  const value = record[key] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.integer && !Number.isInteger(value)) ||
    (options.allowZero ? value < 0 : value <= 0)
  ) {
    throw new Error(`1Password config ${key} must be a valid positive number`);
  }
  return value;
}

export function parseOnePasswordConfig(value: unknown): OnePasswordConfig | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return undefined;
  }
  const vault = requiredString(value, "vault");
  if (vault.startsWith("-")) {
    throw new Error("1Password config vault must not start with a hyphen");
  }
  const defaultPolicy = readPolicy(value.defaultPolicy, "defaultPolicy", "approve");
  if (!isRecord(value.items) || Object.keys(value.items).length === 0) {
    throw new Error("1Password config items must contain at least one registered slug");
  }
  if (Object.keys(value.items).length > MAX_REGISTERED_ITEMS) {
    throw new Error(
      `1Password config items must contain at most ${MAX_REGISTERED_ITEMS} registered slugs`,
    );
  }

  const items: Record<string, OnePasswordItemConfig> = Object.create(null);
  for (const [slug, rawItem] of Object.entries(value.items)) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`Invalid 1Password item slug: ${slug}`);
    }
    if (!isRecord(rawItem)) {
      throw new Error(`1Password config item ${slug} must be an object`);
    }
    const item = requiredString(rawItem, "item");
    // Item and vault land in op argv; a leading hyphen would parse as a CLI flag.
    if (item.startsWith("-")) {
      throw new Error(`1Password config item ${slug} item must not start with a hyphen`);
    }
    const itemVault = optionalString(rawItem, "vault") ?? vault;
    if (itemVault.startsWith("-")) {
      throw new Error(`1Password config item ${slug} vault must not start with a hyphen`);
    }
    const description = optionalString(rawItem, "description");
    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `1Password config item ${slug} description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }
    const field = optionalString(rawItem, "field") ?? "credential";
    // op treats commas in --fields as multiple selectors. Reject them so one
    // registry entry can never load more than its single configured field.
    if (field.includes(",")) {
      throw new Error(`1Password config item ${slug} field must not contain commas`);
    }
    items[slug] = {
      item,
      vault: itemVault,
      field,
      policy: readPolicy(rawItem.policy, `items.${slug}.policy`, defaultPolicy),
      ...(description ? { description } : {}),
    };
  }

  const opBin = optionalString(value, "opBin");
  if (opBin && !path.isAbsolute(opBin)) {
    throw new Error("1Password config opBin must be an absolute path");
  }

  return {
    vault,
    ...(opBin ? { opBin } : {}),
    defaultPolicy,
    cacheTtlSeconds: readNumber(value, "cacheTtlSeconds", 300, {
      integer: true,
      allowZero: true,
    }),
    grantTtlHours: readNumber(value, "grantTtlHours", 720, {
      integer: false,
      allowZero: false,
    }),
    opTimeoutMs: readNumber(value, "opTimeoutMs", 15_000, {
      integer: true,
      allowZero: false,
    }),
    items,
  };
}
