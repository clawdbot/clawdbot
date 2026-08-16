export function createGatewayStartupSettlement(startupSettled: Promise<void>): {
  startupSettled: Promise<void>;
  settleOnClose: () => void;
} {
  let settleOnClose: () => void = () => {};
  const closeStarted = new Promise<void>((resolve) => {
    settleOnClose = resolve;
  });
  return {
    startupSettled: Promise.race([startupSettled, closeStarted]),
    settleOnClose,
  };
}
