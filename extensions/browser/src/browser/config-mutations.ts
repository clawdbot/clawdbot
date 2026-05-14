import { mutateConfigFile } from "../config/config.js";
import type { BrowserProfileConfig } from "../config/config.js";
import { deriveDefaultBrowserCdpPortRange } from "../config/port-defaults.js";
import { formatErrorMessage } from "../infra/errors.js";
import { assertCdpEndpointAllowed } from "./cdp.helpers.js";
import { resolveBrowserConfig, type ResolvedBrowserConfig } from "./config.js";
import {
  BrowserConflictError,
  BrowserResourceExhaustedError,
  BrowserValidationError,
} from "./errors.js";
import { allocateCdpPort, allocateColor, getUsedColors, getUsedPorts } from "./profiles.js";

type BrowserControlCredential =
  | {
      kind: "token";
      value: string;
    }
  | {
      kind: "password";
      value: string;
    };

const cdpPortRange = (resolved: {
  controlPort: number;
  cdpPortRangeStart?: number;
  cdpPortRangeEnd?: number;
}): { start: number; end: number } => {
  const start = resolved.cdpPortRangeStart;
  const end = resolved.cdpPortRangeEnd;
  if (
    typeof start === "number" &&
    Number.isFinite(start) &&
    Number.isInteger(start) &&
    typeof end === "number" &&
    Number.isFinite(end) &&
    Number.isInteger(end) &&
    start > 0 &&
    end >= start &&
    end <= 65535
  ) {
    return { start, end };
  }

  return deriveDefaultBrowserCdpPortRange(resolved.controlPort);
};

export async function persistBrowserControlCredential(
  credential: BrowserControlCredential,
): Promise<void> {
  await mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      draft.gateway = {
        ...draft.gateway,
        auth: {
          ...draft.gateway?.auth,
          [credential.kind]: credential.value,
        },
      };
    },
  });
}

export async function createBrowserProfileConfig(params: {
  name: string;
  resolved: ResolvedBrowserConfig;
  color?: string;
  parsedCdpUrl?: string;
  userDataDir?: string;
  driver?: "openclaw" | "existing-session";
}): Promise<BrowserProfileConfig | undefined> {
  const mutation = await mutateConfigFile<BrowserProfileConfig>({
    afterWrite: { mode: "auto" },
    mutate: async (draft) => {
      const rawDraftBrowser = draft.browser as
        | (NonNullable<typeof draft.browser> & { cdpPortRangeEnd?: unknown })
        | undefined;
      const draftCdpPortRangeEnd =
        typeof rawDraftBrowser?.cdpPortRangeEnd === "number"
          ? rawDraftBrowser.cdpPortRangeEnd
          : undefined;
      const useRebasedPortRange =
        draft.gateway?.port !== undefined ||
        draft.browser?.cdpPortRangeStart !== undefined ||
        draftCdpPortRangeEnd !== undefined;
      const latestResolved = resolveBrowserConfig(
        {
          ...params.resolved,
          ...draft.browser,
          profiles: draft.browser?.profiles ?? params.resolved.profiles,
        },
        draft,
      );
      const latestRootResolved = resolveBrowserConfig(draft.browser, draft);
      const latestProfileSource = useRebasedPortRange ? latestRootResolved : latestResolved;
      const latestProfiles = draft.browser?.profiles ?? {};
      if (params.name in latestProfiles || params.name in latestProfileSource.profiles) {
        throw new BrowserConflictError(`profile "${params.name}" already exists`);
      }

      const profileColor =
        params.color ?? allocateColor(getUsedColors(latestProfileSource.profiles));

      let nextProfileConfig: BrowserProfileConfig;
      if (params.parsedCdpUrl) {
        try {
          await assertCdpEndpointAllowed(params.parsedCdpUrl, latestResolved.ssrfPolicy);
        } catch (err) {
          throw new BrowserValidationError(formatErrorMessage(err));
        }
        nextProfileConfig = {
          cdpUrl: params.parsedCdpUrl,
          ...(params.driver ? { driver: params.driver } : {}),
          color: profileColor,
        };
      } else if (params.driver === "existing-session") {
        nextProfileConfig = {
          driver: params.driver,
          attachOnly: true,
          ...(params.userDataDir ? { userDataDir: params.userDataDir } : {}),
          color: profileColor,
        };
      } else {
        const usedPorts = getUsedPorts(latestProfileSource.profiles);
        const rangeSource = useRebasedPortRange ? latestRootResolved : params.resolved;
        const range = cdpPortRange({
          controlPort: rangeSource.controlPort,
          cdpPortRangeStart: rangeSource.cdpPortRangeStart,
          cdpPortRangeEnd: draftCdpPortRangeEnd ?? rangeSource.cdpPortRangeEnd,
        });
        const cdpPort = allocateCdpPort(usedPorts, range);
        if (cdpPort === null) {
          throw new BrowserResourceExhaustedError("no available CDP ports in range");
        }
        nextProfileConfig = {
          cdpPort,
          ...(params.driver ? { driver: params.driver } : {}),
          color: profileColor,
        };
      }

      draft.browser = {
        ...draft.browser,
        profiles: {
          ...draft.browser?.profiles,
          [params.name]: nextProfileConfig,
        },
      };
      return nextProfileConfig;
    },
  });
  return mutation.result;
}

export async function deleteBrowserProfileConfig(name: string): Promise<void> {
  await mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const { [name]: _removed, ...remainingProfiles } = draft.browser?.profiles ?? {};
      const nextBrowser = {
        ...draft.browser,
        profiles: remainingProfiles,
      };
      if (nextBrowser.defaultProfile === name) {
        delete nextBrowser.defaultProfile;
      }
      draft.browser = nextBrowser;
    },
  });
}
