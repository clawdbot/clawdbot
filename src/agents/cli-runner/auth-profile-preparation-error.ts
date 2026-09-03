/** Typed terminal fact for a selected profile that fails before CLI spawn. */
import { FailoverError } from "../failover-error.js";

export class CliAuthProfilePreparationError extends FailoverError {
  declare readonly profileId: string;
  declare readonly provider: string;
  readonly agentDir: string;

  constructor(params: {
    message: string;
    profileId: string;
    provider: string;
    agentDir: string;
    cause?: unknown;
  }) {
    super(params.message, {
      reason: "auth",
      provider: params.provider,
      profileId: params.profileId,
      cause: params.cause,
    });
    this.name = "CliAuthProfilePreparationError";
    this.agentDir = params.agentDir;
  }
}
