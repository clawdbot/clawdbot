type MacFormFactor = "laptop" | "mini" | "studio" | "pro" | "imac";

// Apple-silicon entries from kyle-seongwoo-jun/apple-device-identifiers (MIT; see apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md).
const APPLE_SILICON_FORM_FACTORS: Record<string, MacFormFactor> = {
  "Mac13,1": "studio",
  "Mac13,2": "studio",
  "Mac14,2": "laptop",
  "Mac14,3": "mini",
  "Mac14,5": "laptop",
  "Mac14,6": "laptop",
  "Mac14,7": "laptop",
  "Mac14,8": "pro",
  "Mac14,9": "laptop",
  "Mac14,10": "laptop",
  "Mac14,12": "mini",
  "Mac14,13": "studio",
  "Mac14,14": "studio",
  "Mac14,15": "laptop",
  "Mac15,3": "laptop",
  "Mac15,4": "imac",
  "Mac15,5": "imac",
  "Mac15,6": "laptop",
  "Mac15,7": "laptop",
  "Mac15,8": "laptop",
  "Mac15,9": "laptop",
  "Mac15,10": "laptop",
  "Mac15,11": "laptop",
  "Mac15,12": "laptop",
  "Mac15,13": "laptop",
  "Mac15,14": "studio",
  "Mac16,1": "laptop",
  "Mac16,2": "imac",
  "Mac16,3": "imac",
  "Mac16,5": "laptop",
  "Mac16,6": "laptop",
  "Mac16,7": "laptop",
  "Mac16,8": "laptop",
  "Mac16,9": "studio",
  "Mac16,10": "mini",
  "Mac16,11": "mini",
  "Mac16,12": "laptop",
  "Mac16,13": "laptop",
  "Mac17,2": "laptop",
};

const MACBOOK_AIR_IDENTIFIERS = new Set([
  "Mac14,2",
  "Mac14,15",
  "Mac15,12",
  "Mac15,13",
  "Mac16,12",
  "Mac16,13",
]);

export function resolveMacFormFactor(identifier?: string): MacFormFactor | undefined {
  const model = identifier?.trim();
  if (!model) {
    return undefined;
  }
  if (model.startsWith("MacBook")) {
    return "laptop";
  }
  if (model.startsWith("Macmini")) {
    return "mini";
  }
  if (model.startsWith("MacPro")) {
    return "pro";
  }
  if (model.startsWith("iMac")) {
    return "imac";
  }
  return APPLE_SILICON_FORM_FACTORS[model];
}

export function macFamilyLabel(identifier?: string): string | undefined {
  const model = identifier?.trim();
  if (!model) {
    return undefined;
  }
  switch (resolveMacFormFactor(model)) {
    case "laptop":
      if (model.startsWith("MacBookAir") || MACBOOK_AIR_IDENTIFIERS.has(model)) {
        return "MacBook Air";
      }
      return /^MacBook\d/.test(model) ? "MacBook" : "MacBook Pro";
    case "mini":
      return "Mac mini";
    case "studio":
      return "Mac Studio";
    case "pro":
      return "Mac Pro";
    case "imac":
      return "iMac";
    default:
      return undefined;
  }
}
