import { readMissingScopeError } from "@openclaw/gateway-client/browser";
import type {
  FsDirEntry,
  FsListDirResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { isAbsolutePath, sameAbsolutePath } from "./path.ts";
import { resolvePlaceBrowserView, splitBrowserDraft } from "./place-browser-view.ts";

export const PICKER_INPUT_DEBOUNCE_MS = 300;

export class PlaceBrowserState {
  listing: FsListDirResult | null = null;
  draft = "";
  loading = false;
  error: string | null = null;
  activeIndex = 0;
  private token = 0;
  private listingGenerationValue = 0;
  private timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  constructor(
    private readonly listDirectory: (path?: string) => Promise<FsListDirResult>,
    private readonly requestUpdate: () => void,
    private readonly onListing?: (listing: FsListDirResult) => void,
  ) {}

  get listingGeneration(): number {
    return this.listingGenerationValue;
  }

  navigate(path: string | undefined): Promise<void> {
    this.cancelPending();
    this.draft = path ?? "";
    this.error = null;
    this.loading = true;
    this.requestUpdate();
    return this.load(path, true, this.token);
  }

  setDraft(value: string) {
    this.cancelPending();
    this.draft = value;
    this.activeIndex = 0;
    this.error = null;
    const split = splitBrowserDraft(value.trim());
    this.loading = Boolean(split && !this.draftInLoadedDirectory());
    if (split && this.loading) {
      const requestId = this.token;
      // Mark loading before the debounce so an unloaded directory never flashes "no matches".
      this.timer = globalThis.setTimeout(() => {
        this.timer = undefined;
        void this.load(split.directory, false, requestId);
      }, PICKER_INPUT_DEBOUNCE_MS);
    }
    this.requestUpdate();
  }

  draftInLoadedDirectory(): boolean {
    if (!this.listing) {
      return false;
    }
    const draft = this.draft.trim();
    const split = splitBrowserDraft(draft);
    return (
      !split ||
      sameAbsolutePath(draft, this.listing.path) ||
      sameAbsolutePath(split.directory, this.listing.path)
    );
  }

  moveHighlight(delta: 1 | -1) {
    const count = this.view().entries.length;
    if (count === 0) {
      return;
    }
    this.activeIndex = (this.activeIndex + delta + count) % count;
    this.requestUpdate();
  }

  highlightedEntry(): FsDirEntry | undefined {
    const entries = this.view().entries;
    this.activeIndex = Math.max(0, Math.min(this.activeIndex, entries.length - 1));
    return entries[this.activeIndex];
  }

  completeHighlighted(): boolean {
    const entry = this.highlightedEntry();
    if (!entry || this.draft.trim() === entry.path) {
      return false;
    }
    this.setDraft(entry.path);
    return true;
  }

  async activate(): Promise<void> {
    const entry = this.highlightedEntry();
    const draft = this.draft.trim();
    if (entry) {
      await this.navigate(entry.path);
    } else if (!draft || isAbsolutePath(draft)) {
      await this.navigate(draft || undefined);
    }
  }

  usablePath(): string | null {
    const draft = this.draft.trim();
    return !draft || isAbsolutePath(draft) ? draft : null;
  }

  reset() {
    this.cancelPending();
    this.listing = null;
    this.listingGenerationValue += 1;
    this.draft = "";
    this.loading = false;
    this.error = null;
    this.activeIndex = 0;
  }

  view() {
    const draft = this.draft.trim();
    return resolvePlaceBrowserView({ listing: this.listing, draft, loading: this.loading });
  }

  private cancelPending() {
    // Retire in-flight responses immediately, including while the next load is still debouncing.
    this.token += 1;
    globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async load(path: string | undefined, navigation: boolean, requestId: number) {
    const previousListing = this.listing;
    const draftAtRequest = this.draft;
    try {
      const listing = await this.listDirectory(path);
      if (requestId !== this.token) {
        return;
      }
      this.listing = listing;
      this.listingGenerationValue += 1;
      if (navigation && this.draft === draftAtRequest) {
        this.draft = listing.path;
      }
      // Typed loads keep the requested spelling. A different Gateway-canonicalized write-scope
      // symlink path intentionally shows "No matching folders" instead of children.
      this.activeIndex = 0;
      this.onListing?.(listing);
    } catch (error) {
      if (requestId !== this.token) {
        return;
      }
      // Typed directories may be incomplete; only explicit navigation reports a hard failure.
      if (navigation) {
        this.error ??= readMissingScopeError(error)?.missingScope
          ? t("newSession.browseRequiresAdmin")
          : t("newSession.browserLoadFailed");
        if (!previousListing && path) {
          this.draft = "";
          await this.load(undefined, true, requestId);
        }
      }
    } finally {
      if (requestId === this.token) {
        this.loading = false;
        this.requestUpdate();
      }
    }
  }
}
