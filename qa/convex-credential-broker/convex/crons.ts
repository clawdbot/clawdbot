import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "qa-credential-lease-event-retention",
  { hours: 1 },
  internal.credentials.cleanupLeaseEvents,
  {},
);

crons.interval(
  "qa-credential-admin-event-retention",
  { hours: 1 },
  internal.credentials.cleanupAdminEvents,
  {},
);

export default crons;
