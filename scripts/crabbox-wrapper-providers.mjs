const providerAliases = new Map([
  ["blacksmith", "blacksmith-testbox"],
  ["cf", "cloudflare"],
  ["container", "local-container"],
  ["docker", "local-container"],
  ["exe", "exe-dev"],
  ["exedev", "exe-dev"],
  ["google", "gcp"],
  ["google-cloud", "gcp"],
  ["local-docker", "local-container"],
  ["namespace", "namespace-devbox"],
  ["namespace-devboxes", "namespace-devbox"],
  ["rail", "railway"],
  ["railwayapp", "railway"],
  ["run-pod", "runpod"],
  ["runpodio", "runpod"],
  ["sem", "semaphore"],
  ["static", "ssh"],
  ["static-ssh", "ssh"],
  ["tensorlake-sbx", "tensorlake"],
  ["tl", "tensorlake"],
]);

// Crabbox providerHelpAll can omit Tensorlake even when the binary accepts it.
const providerHelpOmissions = new Set(["tensorlake"]);

export function canonicalProviderName(provider) {
  return providerAliases.get(provider) ?? provider;
}

function addProviderNames(names, text) {
  for (const name of text
    .replace(/\s+\(default\b.*$/u, "")
    .split(/\s*(?:,|\||\bor\b)\s*/u)
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
      names.add(name);
    }
  }
}

function providerListContinuation(line, previousText) {
  const match = line.match(
    /^\s*((?:or\s+)?[a-z0-9][a-z0-9-]*(?:\s*(?:,|\||\bor\b)\s*(?:or\s+)?[a-z0-9][a-z0-9-]*)*\s*(?:,|\|)?)(?:\s+\(default\b.*)?\s*$/u,
  );
  if (!match) {
    return "";
  }
  if (/[,|]\s*$/u.test(previousText) || /[,|]|\bor\b|\(default\b/u.test(line)) {
    return match[1];
  }
  return "";
}

export function parseProvidersFromHelp(text) {
  const names = new Set();
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const providerMatch = line.match(/provider:\s*([a-z0-9][a-z0-9, -]*)(?:\s*\(default\b|$)/u);
    if (providerMatch) {
      let providerText = providerMatch[1];
      while (!/\(default\b/u.test(lines[index]) && index + 1 < lines.length) {
        const continuation = providerListContinuation(lines[index + 1], providerText);
        if (!continuation) {
          break;
        }
        index += 1;
        providerText = `${providerText} ${continuation}`;
      }
      addProviderNames(names, providerText);
      continue;
    }

    const flagMatch = line.match(
      /^\s+-{1,2}provider(?:[=\s]+)([a-z0-9][a-z0-9|, -]*)(?:\s{2,}|\s+\(|$)/u,
    );
    if (flagMatch && /[,|]|\bor\b/u.test(flagMatch[1])) {
      addProviderNames(names, flagMatch[1]);
    }
  }
  return [...names];
}

export function isProviderAdvertised(provider, advertisedProviders) {
  const canonicalProvider = canonicalProviderName(provider);
  return (
    advertisedProviders.includes(provider) ||
    advertisedProviders.includes(canonicalProvider) ||
    providerHelpOmissions.has(canonicalProvider)
  );
}
