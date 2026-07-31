const NOTIFICATION_COMMANDS = ["notifications.list"];

export const MOBILE_NODE_COMMANDS = {
  location: ["location.get"],
  notification: NOTIFICATION_COMMANDS,
  androidNotification: [...NOTIFICATION_COMMANDS, "notifications.actions"],
  device: ["device.info", "device.status"],
};
