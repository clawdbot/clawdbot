import { type APIRole, type APIUser } from "discord-api-types/v10";
import { Role, User, type StructureClient } from "./structures.js";

type ModalResolvedData = {
  roles?: Record<string, { id: string; name?: string }>;
  users?: Record<string, { id: string; username?: string; discriminator?: string }>;
};

export function extractModalFields(components: unknown[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const component of flattenModalComponents(components)) {
    const raw = component as { custom_id?: unknown; value?: unknown; values?: unknown };
    if (typeof raw.custom_id !== "string") {
      continue;
    }
    if (Array.isArray(raw.values)) {
      out[raw.custom_id] = raw.values.map(String);
    } else if (
      typeof raw.value === "string" ||
      typeof raw.value === "number" ||
      typeof raw.value === "boolean"
    ) {
      out[raw.custom_id] = String(raw.value);
    }
  }
  return out;
}

function flattenModalComponents(components: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const entry of components) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const component = entry as { component?: unknown; components?: unknown[] };
    if (component.component && typeof component.component === "object") {
      out.push(component.component);
    }
    if (Array.isArray(component.components)) {
      out.push(...flattenModalComponents(component.components));
    }
    out.push(entry);
  }
  return out;
}

export class ModalFields {
  constructor(
    private values: Record<string, string | string[]>,
    private resolved?: ModalResolvedData,
    private client?: StructureClient,
  ) {}

  private value(id: string, required: boolean): string | string[] | undefined {
    const value = this.values[id];
    if (required && (value === undefined || (Array.isArray(value) && value.length === 0))) {
      throw new Error(`Missing required modal field ${id}`);
    }
    return value;
  }

  getText(id: string, required = false): string | null {
    const value = this.value(id, required);
    return typeof value === "string" ? value : null;
  }

  getStringSelect(id: string, required = false): string[] {
    const value = this.value(id, required);
    if (Array.isArray(value)) {
      return value;
    }
    return typeof value === "string" ? [value] : [];
  }

  getRoleSelect(id: string, required = false): Role[] {
    const values = this.getStringSelect(id, required);
    return values.map((roleId) => {
      const raw = this.resolved?.roles?.[roleId];
      return raw
        ? new Role(this.client!, { id: roleId, name: raw.name ?? "" } as APIRole)
        : new Role<true>(this.client!, roleId);
    });
  }

  getUserSelect(id: string, required = false): User[] {
    const values = this.getStringSelect(id, required);
    return values.map((userId) => {
      const raw = this.resolved?.users?.[userId];
      return new User(this.client!, {
        id: userId,
        username: raw?.username ?? "",
      } as APIUser);
    });
  }
}
