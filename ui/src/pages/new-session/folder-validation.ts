import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";

/** fs.listDir uses INVALID_REQUEST for host filesystem errors; only stable errno markers prove stale input. */
function isMissingRestoredFolderError(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    /^(?:Error:\s+)?(?:ENOENT|ENOTDIR):/u.test(error.message)
  );
}

/** Owns only validation; the draft decides which folder replaces an unavailable preference. */
export class DraftRestoredFolderValidation {
  private state: "none" | "checking" | "failed" = "none";
  private requestToken = 0;

  constructor(
    private readonly read: () => {
      gateway: ApplicationContext["gateway"]["snapshot"] | undefined;
      folder: string;
      selectedByUser: boolean;
      isAdmin: boolean;
    },
    private readonly callbacks: {
      onApprovedListing: (listing: FsListDirResult) => void;
      onVerified: () => void;
      onMissing: () => void;
      onFailed: () => void;
    },
  ) {}

  get blocked(): boolean {
    return this.state !== "none";
  }

  cancel() {
    this.requestToken += 1;
    this.state = "none";
  }

  private restore() {
    this.state = "none";
    this.callbacks.onMissing();
  }

  validate(folder: string) {
    const snapshot = this.read().gateway;
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client) {
      this.restore();
      return;
    }
    const requestId = ++this.requestToken;
    this.state = "checking";
    const isCurrent = () => {
      const current = this.read();
      return (
        requestId === this.requestToken && !current.selectedByUser && current.folder === folder
      );
    };
    void client
      .request<FsListDirResult>("fs.listDir", { path: folder })
      .then((result) => {
        if (!isCurrent()) {
          return;
        }
        this.callbacks.onApprovedListing(result);
        this.state = "none";
        this.callbacks.onVerified();
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        if (!this.read().isAdmin || isMissingRestoredFolderError(error)) {
          this.restore();
          return;
        }
        this.state = "failed";
        this.callbacks.onFailed();
      });
  }
}
