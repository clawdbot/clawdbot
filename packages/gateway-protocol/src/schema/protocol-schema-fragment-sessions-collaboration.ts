import * as sessionDiscussion from "./session-discussion.js";
import * as sessionGitHubPublication from "./session-github-publication.js";
import * as sessionPlacement from "./session-placement.js";
import * as sessionsSharing from "./sessions-sharing.js";
import * as sessionsSuggestions from "./sessions-suggestions.js";

export const SessionCollaborationProtocolSchemas = {
  SessionGitHubOptionsParams: sessionGitHubPublication.SessionGitHubOptionsParamsSchema,
  SessionGitHubOptionsResult: sessionGitHubPublication.SessionGitHubOptionsResultSchema,
  SessionGitHubStatusParams: sessionGitHubPublication.SessionGitHubStatusParamsSchema,
  SessionGitHubStatusResult: sessionGitHubPublication.SessionGitHubStatusResultSchema,
  SessionGitHubConfirmParams: sessionGitHubPublication.SessionGitHubConfirmParamsSchema,
  SessionGitHubPublishParams: sessionGitHubPublication.SessionGitHubPublishParamsSchema,
  SessionGitHubPublicationRequested:
    sessionGitHubPublication.SessionGitHubPublicationRequestedSchema,
  SessionGitHubPublicationPublishing:
    sessionGitHubPublication.SessionGitHubPublicationPublishingSchema,
  SessionGitHubPublicationPublished:
    sessionGitHubPublication.SessionGitHubPublicationPublishedSchema,
  SessionGitHubPublicationFailed: sessionGitHubPublication.SessionGitHubPublicationFailedSchema,
  SessionGitHubPublicationNeedsConfirmation:
    sessionGitHubPublication.SessionGitHubPublicationNeedsConfirmationSchema,
  SessionGitHubPublicationResult: sessionGitHubPublication.SessionGitHubPublicationResultSchema,
  SessionVisibility: sessionsSharing.SessionVisibilitySchema,
  SessionSharingIdentity: sessionsSharing.SessionSharingIdentitySchema,
  SessionSharingRole: sessionsSharing.SessionSharingRoleSchema,
  SessionVisibilitySetParams: sessionsSharing.SessionVisibilitySetParamsSchema,
  SessionVisibilitySetResult: sessionsSharing.SessionVisibilitySetResultSchema,
  SessionPublicShare: sessionsSharing.SessionPublicShareSchema,
  SessionPublicShareSetParams: sessionsSharing.SessionPublicShareSetParamsSchema,
  SessionPublicShareSetResult: sessionsSharing.SessionPublicShareSetResultSchema,
  SessionMembersListParams: sessionsSharing.SessionMembersListParamsSchema,
  SessionMember: sessionsSharing.SessionMemberSchema,
  SessionMemberEvidence: sessionsSharing.SessionMemberEvidenceSchema,
  SessionMembersListResult: sessionsSharing.SessionMembersListResultSchema,
  SessionMembersListEvidenceResult: sessionsSharing.SessionMembersListEvidenceResultSchema,
  SessionMemberAddParams: sessionsSharing.SessionMemberAddParamsSchema,
  SessionMemberRemoveParams: sessionsSharing.SessionMemberRemoveParamsSchema,
  SessionMemberMutationResult: sessionsSharing.SessionMemberMutationResultSchema,
  SessionSharingAction: sessionsSharing.SessionSharingActionSchema,
  SessionSharingEvent: sessionsSharing.SessionSharingEventSchema,
  SessionSharingEvidenceEvent: sessionsSharing.SessionSharingEvidenceEventSchema,
  SessionSuggestionState: sessionsSuggestions.SessionSuggestionStateSchema,
  SessionSuggestionAction: sessionsSuggestions.SessionSuggestionActionSchema,
  SessionSuggestionResolution: sessionsSuggestions.SessionSuggestionResolutionSchema,
  SessionSuggestion: sessionsSuggestions.SessionSuggestionSchema,
  SessionSuggestionsAddParams: sessionsSuggestions.SessionSuggestionsAddParamsSchema,
  SessionSuggestionsAddResult: sessionsSuggestions.SessionSuggestionsAddResultSchema,
  SessionSuggestionsListParams: sessionsSuggestions.SessionSuggestionsListParamsSchema,
  SessionSuggestionsListResult: sessionsSuggestions.SessionSuggestionsListResultSchema,
  SessionSuggestionsResolveParams: sessionsSuggestions.SessionSuggestionsResolveParamsSchema,
  SessionSuggestionsResolveResult: sessionsSuggestions.SessionSuggestionsResolveResultSchema,
  SessionSuggestionEvent: sessionsSuggestions.SessionSuggestionEventSchema,
  SessionTypingParams: sessionsSuggestions.SessionTypingParamsSchema,
  SessionTypingResult: sessionsSuggestions.SessionTypingResultSchema,
  SessionTypingEvent: sessionsSuggestions.SessionTypingEventSchema,
  ...sessionPlacement.SessionPlacementProtocolSchemas,
  SessionDiscussionState: sessionDiscussion.SessionDiscussionStateSchema,
  SessionDiscussionInfo: sessionDiscussion.SessionDiscussionInfoSchema,
  SessionDiscussionInfoParams: sessionDiscussion.SessionDiscussionInfoParamsSchema,
  SessionDiscussionInfoResult: sessionDiscussion.SessionDiscussionInfoResultSchema,
  SessionDiscussionOpenParams: sessionDiscussion.SessionDiscussionOpenParamsSchema,
  SessionDiscussionOpenResult: sessionDiscussion.SessionDiscussionOpenResultSchema,
} as const;
