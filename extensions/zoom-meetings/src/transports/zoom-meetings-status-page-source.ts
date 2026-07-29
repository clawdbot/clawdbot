export function zoomMeetingStatusPageSource(): string {
  return `  const pageText = text(document.body);
  const pageTextLower = pageText.toLowerCase();
  const lobbyWaiting = Boolean(first(selectors.lobby)) ||
    /host will let you in soon|waiting for the host to start|someone will let you in shortly|waiting for someone to let you in|when someone admits you|you.?re in the lobby|we.?ve let people in the meeting know you.?re waiting/i.test(pageTextLower);
`;
}
