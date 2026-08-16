export function createGatewayStartupSettlement(startupSettled: Promise<void>): {
  startupJoin: Promise<void>;
  settleOnClose: () => void;
} {
  let settleOnClose: () => void = () => {};
  const closeStarted = new Promise<void>((resolve) => {
    settleOnClose = resolve;
  });
  return {
    startupJoin: Promise.race([startupSettled, closeStarted]),
    settleOnClose,
  };
}
