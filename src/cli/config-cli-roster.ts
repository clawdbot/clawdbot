import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readAgentRosterProperty } from "../agents/agent-scope-config.js";
import { parseLegacyAgentRoster } from "../config/legacy.roster.js";
import type { ConfigSetOperation } from "./config-cli-input.js";
import { getAtPath, type PathSegment } from "./config-cli-path.js";

/** Keeps the documented list input and keyed input on one mutable roster. */
export class ConfigMutationAgentRoster {
  private legacyOrder: string[] | undefined;

  constructor(
    private readonly root: Record<string, unknown>,
    sourceConfigBeforeMigrations: unknown,
  ) {
    const sourceRoster = readAgentRosterProperty(sourceConfigBeforeMigrations);
    this.legacyOrder =
      sourceRoster?.kind === "list" ? parseLegacyAgentRoster(sourceRoster.value)?.order : undefined;
  }

  prepare(operation: ConfigSetOperation, merge: boolean): void {
    const path = operation.setPath;
    if (path[0] !== "agents") {
      return;
    }
    if (
      path.length === 1 &&
      isRecord(operation.value) &&
      Object.hasOwn(operation.value, "list") &&
      Object.hasOwn(operation.value, "entries")
    ) {
      throw new Error("Set either agents.list or agents.entries in one value, not both.");
    }
    const submittedRoster =
      path.length === 1 ? readAgentRosterProperty({ agents: operation.value }) : undefined;
    const kind = path.length === 1 ? submittedRoster?.kind : path[1];
    const roster = readAgentRosterProperty(this.root);
    // A removed roster's indexes cannot select entries in its replacement.
    if (!roster) {
      this.legacyOrder = undefined;
    }
    const agents = this.root.agents;
    if ((kind !== "list" && kind !== "entries") || !isRecord(agents)) {
      return;
    }
    // Whole replacements discard the old representation without validating it.
    // A list deletion still needs projection so unset can find its keyed target.
    if (path.length <= 2 && !merge && (kind === "entries" || operation.mutation !== "delete")) {
      delete agents[kind === "entries" ? "list" : "entries"];
      this.legacyOrder = undefined;
      return;
    }
    if (kind === "entries") {
      if (roster?.kind === "list") {
        this.canonicalize(true);
      }
      return;
    }
    if (roster?.kind !== "entries") {
      return;
    }
    if (
      !isRecord(roster.value) ||
      Object.values(roster.value).some((entry) => !isRecord(entry) || Object.hasOwn(entry, "id"))
    ) {
      throw new Error(
        "Cannot address agents.list while agents.entries contains invalid entries; correct the keyed roster first.",
      );
    }
    const entries = roster.value;
    // Integer-like ids enumerate numerically in objects. A keyed leaf edit must not
    // change the index selected by a later operation in the same submitted list.
    const order = [...new Set([...(this.legacyOrder ?? []), ...Object.keys(entries)])].filter(
      (id) => Object.hasOwn(entries, id),
    );
    const list = [];
    for (const id of order) {
      // SAFETY: The roster check above rejects non-record entries and conflicting in-entry ids.
      list.push({ ...(entries[id] as Record<string, unknown>), id });
    }
    agents.list = list;
    delete agents.entries;
  }

  writePath(path: PathSegment[]): PathSegment[] {
    if (path[0] !== "agents" || path[1] !== "list") {
      return path;
    }
    if (path.length === 2) {
      const roster = readAgentRosterProperty(this.root);
      return roster?.kind === "list" && parseLegacyAgentRoster(roster.value)
        ? ["agents", "entries"]
        : path;
    }
    const entry = getAtPath(this.root, path.slice(0, 3));
    const roster = entry.found ? parseLegacyAgentRoster([entry.value]) : undefined;
    const id = roster?.order[0];
    return id === undefined ? path : ["agents", "entries", id, ...path.slice(3)];
  }

  finish(): void {
    this.canonicalize(false);
  }

  private canonicalize(required: boolean): void {
    const agents = this.root.agents;
    const roster = readAgentRosterProperty(this.root);
    if (!isRecord(agents) || roster?.kind !== "list") {
      return;
    }
    const parsed = parseLegacyAgentRoster(roster.value);
    if (!parsed) {
      if (required) {
        throw new Error(
          "Cannot address agents.entries while agents.list contains invalid or duplicate ids; correct the list first.",
        );
      }
      return;
    }
    this.legacyOrder = parsed.order;
    agents.entries = parsed.entries;
    delete agents.list;
  }
}
