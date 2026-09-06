import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { stripFrontmatterBlock } from "../../../../packages/markdown-core/src/frontmatter.js";
import { icons } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";
import type { SkillWorkshopProps } from "./view-types.ts";

// Skills and drafts are untrusted preview material. Show complete instructions,
// but keep remote images as links to avoid fetching them during review.
export function renderSkillDocument(body: string) {
  return html`<article class="sidebar-markdown">
    ${unsafeHTML(
      toSanitizedMarkdownHtml(stripFrontmatterBlock(body), {
        mode: "document",
        codeBlockChrome: "none",
        remoteImages: false,
      }),
    )}
  </article>`;
}

type InstalledSkill = SkillWorkshopProps["installedSkills"][number];

export function renderSkillWorkshopCollection(props: SkillWorkshopProps) {
  const query = props.query.trim().toLowerCase();
  const matches = query
    ? props.installedSkills.filter((skill) =>
        `${skill.name} ${skill.description}`.toLowerCase().includes(query),
      )
    : props.installedSkills;

  return html`
    <div class="sw-collection">
      <div class="sw-collection__head">
        <label class="sw-collection__search">
          ${icons.search}
          <input
            type="search"
            aria-label=${t("skillWorkshop.collection.searchLabel")}
            placeholder=${t("skillWorkshop.collection.search")}
            .value=${props.query}
            @input=${(event: Event) =>
              // SAFETY: handler is bound on the <input> itself, so currentTarget is that element.
              props.onQueryChange((event.currentTarget as HTMLInputElement).value ?? "")}
          />
        </label>
        <p class="sw-collection__count">${collectionCountLabel(props, matches.length)}</p>
        <button
          type="button"
          class="btn btn--sm"
          aria-label=${t("skillWorkshop.collection.refresh")}
          ?disabled=${props.loading}
          @click=${props.onRetry}
        >
          ${t("common.refresh")}
        </button>
      </div>
      <div class="sw-collection__panes">
        <aside class="sw-collection__shelf" aria-label=${t("skillWorkshop.collection.shelfLabel")}>
          ${renderShelf(props, matches)}
        </aside>
        <section class="sw-collection__reader">${renderReader(props)}</section>
      </div>
    </div>
  `;
}

/**
 * A failed list read keeps whatever rows were last seen, so the count is
 * withheld rather than presented as a fresh inventory.
 */
function collectionCountLabel(props: SkillWorkshopProps, shown: number): string {
  const total = props.installedSkills.length;
  if (props.error) {
    return t("skillWorkshop.collection.countUnavailable");
  }
  if (props.loading) {
    return t("skillWorkshop.collection.loading");
  }
  if (shown !== total) {
    return t("skillWorkshop.collection.countFiltered", {
      shown: String(shown),
      total: String(total),
    });
  }
  return total === 1
    ? t("skillWorkshop.collection.countOne")
    : t("skillWorkshop.collection.count", { count: String(total) });
}

function renderShelf(props: SkillWorkshopProps, matches: InstalledSkill[]) {
  if (props.installedSkills.length === 0) {
    if (props.error) {
      return renderCollectionState({
        title: t("skillWorkshop.collection.errorTitle"),
        body: t("skillWorkshop.collection.errorBody"),
      });
    }
    if (props.loading) {
      return html`<p class="sw-collection__state sw-muted" aria-busy="true">
        ${t("skillWorkshop.collection.loading")}
      </p>`;
    }
    return renderCollectionState({
      title: t("skillWorkshop.collection.emptyTitle"),
      body: t("skillWorkshop.collection.emptyBody"),
      action: {
        label: t("skillWorkshop.collection.seeSuggestions"),
        onClick: () => props.onModeChange("suggestions"),
      },
    });
  }
  if (matches.length === 0) {
    return renderCollectionState({
      title: t("skillWorkshop.collection.noMatchTitle"),
      body: t("skillWorkshop.collection.noMatchBody"),
      action: {
        label: t("skillWorkshop.collection.clearSearch"),
        onClick: () => props.onQueryChange(""),
      },
    });
  }
  const selectedName = selectedInstalledName(props);
  return matches.map((skill) => {
    const isSelected = skill.name === selectedName;
    return html`
      <button
        type="button"
        class="sw-installed-skill ${isSelected ? "is-selected" : ""}"
        aria-current=${isSelected ? "true" : nothing}
        @click=${() => props.onSelectInstalled(skill.name)}
      >
        <span class="sw-installed-skill__name">${skill.name}</span>
        <span class="sw-installed-skill__desc">${skill.description}</span>
      </button>
    `;
  });
}

function selectedInstalledName(props: SkillWorkshopProps): string | null {
  return props.installedSelection.status === "idle" ? null : props.installedSelection.name;
}

function renderReader(props: SkillWorkshopProps) {
  const selection = props.installedSelection;
  if (selection.status === "idle") {
    if (props.installedSkills.length === 0) {
      return nothing;
    }
    return renderCollectionState({
      title: t("skillWorkshop.collection.pickTitle"),
      body: t("skillWorkshop.collection.pickBody"),
    });
  }
  if (selection.status === "loading") {
    return html`<p class="sw-collection__state sw-muted" aria-busy="true">
      ${t("skillWorkshop.collection.loadingSkill", { name: selection.name })}
    </p>`;
  }
  if (selection.status === "error") {
    return html`
      <div class="sw-collection__state" role="alert">
        <p class="sw-empty__title">
          ${t("skillWorkshop.collection.readErrorTitle", { name: selection.name })}
        </p>
        <p class="sw-empty__sub">${selection.error}</p>
        <button type="button" class="sw-btn" @click=${props.onRetryInstalled}>
          ${t("pluginsPage.tryAgain")}
        </button>
      </div>
    `;
  }

  const skill = props.installedSkills.find((entry) => entry.name === selection.name);
  // Only offer the jump when decided records exist for this skill; history is a
  // separate scope and never supplies the content shown above.
  const historyKey =
    skill &&
    props.proposals.some(
      (proposal) => proposal.status !== "pending" && proposal.slug === skill.skillKey,
    )
      ? skill.skillKey
      : null;
  return html`
    <div class="sw-collection__reader-head">
      <div class="sw-collection__reader-identity">
        <h1 class="sw-collection__reader-title">${selection.name}</h1>
        ${
          skill?.description
            ? html`<p class="sw-collection__reader-desc">${skill.description}</p>`
            : nothing
        }
      </div>
      ${
        historyKey
          ? html`<button
              type="button"
              class="sw-btn sw-btn--ghost"
              @click=${() => props.onShowHistory(historyKey)}
            >
              ${t("skillWorkshop.collection.viewHistory")}
            </button>`
          : nothing
      }
    </div>
    <div class="sw-collection__reader-body">${renderSkillDocument(selection.content)}</div>
  `;
}

function renderCollectionState(params: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return html`
    <div class="sw-collection__state">
      <p class="sw-empty__title">${params.title}</p>
      <p class="sw-empty__sub">${params.body}</p>
      ${
        params.action
          ? html`<button type="button" class="sw-btn" @click=${params.action.onClick}>
              ${params.action.label}
            </button>`
          : nothing
      }
    </div>
  `;
}
