import type { Command } from "commander";
import type { NylasConfig } from "./config.js";
import { NylasClient, NylasApiError } from "./client.js";

type NylasCliContext = {
  program: Command;
  config: NylasConfig;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

export function registerNylasCli(ctx: NylasCliContext): void {
  const { program, config, logger } = ctx;

  const nylas = program
    .command("nylas")
    .description("Nylas email, calendar, and contacts integration");

  // Status command - auto-discovers grants from API
  nylas
    .command("status")
    .description("Check Nylas API connection and discover available grants")
    .action(async () => {
      logger.info("Nylas Plugin Status");
      logger.info("===================");
      logger.info("");

      // Check configuration
      logger.info("Configuration:");
      logger.info(`  API URI: ${config.apiUri}`);
      logger.info(`  API Key: ${config.apiKey ? "configured" : "NOT CONFIGURED"}`);
      logger.info(`  Default Grant ID: ${config.defaultGrantId ?? "not set"}`);
      logger.info(`  Default Timezone: ${config.defaultTimezone}`);

      const namedGrants = Object.keys(config.grants);
      if (namedGrants.length > 0) {
        logger.info(`  Named Grants: ${namedGrants.join(", ")}`);
      }

      logger.info("");

      // Check API connection and discover grants
      if (!config.apiKey) {
        logger.error("Cannot connect to API - apiKey not configured");
        logger.info("");
        logger.info("Add your API key to moltbot.yaml:");
        logger.info("  plugins:");
        logger.info("    entries:");
        logger.info("      nylas:");
        logger.info("        config:");
        logger.info("          apiKey: nyk_v0_your_api_key_here");
        return;
      }

      logger.info("Connecting to Nylas API...");

      try {
        const client = new NylasClient({ config, logger });

        // Discover all grants associated with this API key
        const grantsResponse = await client.listGrants();
        const grants = grantsResponse.data;

        logger.info(`  Connection: OK`);
        logger.info("");

        if (grants.length === 0) {
          logger.warn("No grants found. You need to authenticate email accounts in the Nylas dashboard.");
          logger.info("");
          logger.info("1. Go to https://dashboard.nylas.com");
          logger.info("2. Navigate to Grants section");
          logger.info("3. Click 'Add Account' to authenticate your email");
          return;
        }

        logger.info(`Discovered ${grants.length} authenticated account(s):`);
        logger.info("");

        for (const grant of grants) {
          const status = grant.grantStatus === "valid" ? "active" : grant.grantStatus;
          logger.info(`  Email: ${grant.email}`);
          logger.info(`    Grant ID: ${grant.id}`);
          logger.info(`    Provider: ${grant.provider}`);
          logger.info(`    Status: ${status}`);
          if (grant.scope && grant.scope.length > 0) {
            logger.info(`    Scopes: ${grant.scope.join(", ")}`);
          }
          logger.info("");
        }

        // Show recommended configuration
        if (!config.defaultGrantId && grants.length > 0) {
          logger.info("Recommended configuration for moltbot.yaml:");
          logger.info("");
          logger.info("  plugins:");
          logger.info("    entries:");
          logger.info("      nylas:");
          logger.info("        config:");
          logger.info(`          apiKey: ${config.apiKey.slice(0, 10)}...`);
          logger.info(`          defaultGrantId: ${grants[0].id}`);

          if (grants.length > 1) {
            logger.info("          grants:");
            for (const grant of grants) {
              const name = grant.email.split("@")[0].replace(/[^a-z0-9]/gi, "_").toLowerCase();
              logger.info(`            ${name}: ${grant.id}`);
            }
          }
        }
      } catch (err) {
        if (err instanceof NylasApiError) {
          logger.error(`  Connection: FAILED`);
          logger.error(`  Error: ${err.message}`);
          logger.error(`  Status: ${err.statusCode}`);
          if (err.requestId) {
            logger.error(`  Request ID: ${err.requestId}`);
          }
          if (err.statusCode === 401) {
            logger.info("");
            logger.info("Your API key may be invalid or expired.");
            logger.info("Get a new key from https://dashboard.nylas.com/api-keys");
          }
        } else {
          logger.error(`  Connection: FAILED`);
          logger.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

  // Discover command - fetch grants from API
  nylas
    .command("discover")
    .description("Discover all authenticated accounts from Nylas API")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      if (!config.apiKey) {
        if (opts.json) {
          console.log(JSON.stringify({ error: "API key not configured" }));
        } else {
          logger.error("API key not configured. Set plugins.entries.nylas.config.apiKey");
        }
        return;
      }

      try {
        const client = new NylasClient({ config, logger });
        const grantsResponse = await client.listGrants();
        const grants = grantsResponse.data;

        if (opts.json) {
          console.log(JSON.stringify({
            grants: grants.map((g) => ({
              id: g.id,
              email: g.email,
              provider: g.provider,
              status: g.grantStatus,
              scopes: g.scope,
            })),
          }, null, 2));
          return;
        }

        if (grants.length === 0) {
          logger.warn("No authenticated accounts found.");
          logger.info("");
          logger.info("Authenticate accounts at https://dashboard.nylas.com → Grants → Add Account");
          return;
        }

        logger.info(`Found ${grants.length} authenticated account(s):`);
        logger.info("");

        for (const grant of grants) {
          const status = grant.grantStatus === "valid" ? "active" : grant.grantStatus;
          logger.info(`${grant.email}`);
          logger.info(`  ID: ${grant.id}`);
          logger.info(`  Provider: ${grant.provider} | Status: ${status}`);
          logger.info("");
        }

        // Generate config snippet
        logger.info("Add to moltbot.yaml:");
        logger.info("");
        logger.info("plugins:");
        logger.info("  entries:");
        logger.info("    nylas:");
        logger.info("      config:");
        logger.info(`        apiKey: "${config.apiKey}"`);
        logger.info(`        defaultGrantId: "${grants[0].id}"`);

        if (grants.length > 1) {
          logger.info("        grants:");
          for (const grant of grants) {
            const name = grant.email.split("@")[0].replace(/[^a-z0-9]/gi, "_").toLowerCase();
            logger.info(`          ${name}: "${grant.id}"`);
          }
        }
      } catch (err) {
        if (opts.json) {
          console.log(JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }));
        } else if (err instanceof NylasApiError) {
          logger.error(`API Error: ${err.message} (${err.statusCode})`);
        } else {
          logger.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

  // Test command
  nylas
    .command("test")
    .description("Test Nylas API with a specific grant")
    .option("-g, --grant <grant>", "Grant name or ID to test")
    .action(async (opts: { grant?: string }) => {
      if (!config.apiKey) {
        logger.error("API key not configured. Set plugins.entries.nylas.config.apiKey");
        return;
      }

      try {
        const client = new NylasClient({ config, logger });

        // If no grant specified and no default, try to discover one
        let grantId = opts.grant ?? config.defaultGrantId ?? Object.values(config.grants)[0];

        if (!grantId) {
          logger.info("No grant configured, discovering from API...");
          const grantsResponse = await client.listGrants({ limit: 1 });
          if (grantsResponse.data.length === 0) {
            logger.error("No grants found. Authenticate an account at https://dashboard.nylas.com");
            return;
          }
          grantId = grantsResponse.data[0].id;
          logger.info(`Using discovered grant: ${grantsResponse.data[0].email}`);
        }

        logger.info(`Testing grant: ${grantId}`);
        logger.info("");

        // Get grant details
        const grantDetails = await client.getGrant(grantId);
        logger.info(`Account: ${grantDetails.data.email}`);
        logger.info(`Provider: ${grantDetails.data.provider}`);
        logger.info(`Status: ${grantDetails.data.grantStatus}`);
        logger.info("");

        // Test calendars
        logger.info("Calendars:");
        const calendars = await client.listCalendars(grantId);
        for (const cal of calendars.data.slice(0, 5)) {
          const primary = cal.is_primary ? " (primary)" : "";
          logger.info(`  - ${cal.name}${primary}`);
        }
        if (calendars.data.length > 5) {
          logger.info(`  ... and ${calendars.data.length - 5} more`);
        }

        logger.info("");

        // Test folders
        logger.info("Email Folders:");
        const folders = await client.listFolders(grantId);
        for (const folder of folders.data.slice(0, 10)) {
          const count = folder.total_count !== undefined ? ` (${folder.total_count} emails)` : "";
          logger.info(`  - ${folder.name}${count}`);
        }
        if (folders.data.length > 10) {
          logger.info(`  ... and ${folders.data.length - 10} more`);
        }

        logger.info("");

        // Test recent emails
        logger.info("Recent Emails:");
        const messages = await client.listMessages({ grant: grantId, limit: 5 });
        for (const msg of messages.data) {
          const from = msg.from?.[0]?.email ?? "unknown";
          const subject = msg.subject ?? "(no subject)";
          const date = new Date(msg.date * 1000).toLocaleDateString();
          logger.info(`  - ${date} | ${from} | ${subject.slice(0, 50)}`);
        }

        logger.info("");
        logger.info("All tests passed.");
      } catch (err) {
        if (err instanceof NylasApiError) {
          logger.error(`API Error: ${err.message}`);
          logger.error(`Status: ${err.statusCode}`);
        } else {
          logger.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

  // Grants command - shows both configured and discovered grants
  nylas
    .command("grants")
    .description("List configured and available grants")
    .option("--configured", "Show only configured grants")
    .action(async (opts: { configured?: boolean }) => {
      logger.info("Nylas Grants");
      logger.info("============");
      logger.info("");

      // Show configured grants
      logger.info("Configured:");
      if (config.defaultGrantId) {
        logger.info(`  Default: ${config.defaultGrantId}`);
      }

      const namedGrants = Object.entries(config.grants);
      if (namedGrants.length > 0) {
        for (const [name, id] of namedGrants) {
          logger.info(`  ${name}: ${id}`);
        }
      }

      if (!config.defaultGrantId && namedGrants.length === 0) {
        logger.info("  (none)");
      }

      if (opts.configured) {
        return;
      }

      logger.info("");

      // Fetch from API
      if (!config.apiKey) {
        logger.warn("Cannot discover grants - apiKey not configured");
        return;
      }

      try {
        const client = new NylasClient({ config, logger });
        const grantsResponse = await client.listGrants();
        const grants = grantsResponse.data;

        logger.info("Available from API:");
        if (grants.length === 0) {
          logger.info("  (none - authenticate accounts at dashboard.nylas.com)");
          return;
        }

        for (const grant of grants) {
          const status = grant.grantStatus === "valid" ? "" : ` [${grant.grantStatus}]`;
          logger.info(`  ${grant.email}: ${grant.id}${status}`);
        }
      } catch (err) {
        if (err instanceof NylasApiError) {
          logger.error(`Failed to fetch grants: ${err.message}`);
        } else {
          logger.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
}
