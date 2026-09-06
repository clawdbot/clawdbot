// Generated file. Do not edit directly.
// Source: plugin configContracts.initialConfigDefaults in bundled/official declarations.
// Regenerate: node scripts/generate-initial-plugin-config-defaults.mjs --write

import Foundation

public enum InitialPluginConfigDefaults {
    private static let encoded = "{\"anthropic\":{\"sessionCatalog\":{\"enabled\":false}},\"codex\":{\"sessionCatalog\":{\"enabled\":false}}}"

    public static func applying(to root: [String: Any], ifCreatingFileAt url: URL) -> [String: Any] {
        do {
            _ = try FileManager().attributesOfItem(atPath: url.path)
            return root
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return applying(to: root)
        } catch {
            // An unreadable or otherwise uncertain existing config is not a fresh install.
            return root
        }
    }

    public static func applying(to root: [String: Any]) -> [String: Any] {
        guard let data = encoded.data(using: .utf8),
              let defaults = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return root }
        var output = root
        guard output["plugins"] == nil || output["plugins"] is [String: Any] else { return output }
        var plugins = output["plugins"] as? [String: Any] ?? [:]
        guard plugins["entries"] == nil || plugins["entries"] is [String: Any] else { return output }
        var entries = plugins["entries"] as? [String: Any] ?? [:]
        for (pluginId, rawDefaults) in defaults {
            guard let pluginDefaults = rawDefaults as? [String: Any] else { continue }
            guard entries[pluginId] == nil || entries[pluginId] is [String: Any] else { continue }
            var entry = entries[pluginId] as? [String: Any] ?? [:]
            guard entry["config"] == nil || entry["config"] is [String: Any] else { continue }
            let existing = entry["config"] as? [String: Any] ?? [:]
            entry["config"] = mergeMissing(existing: existing, defaults: pluginDefaults)
            entries[pluginId] = entry
        }
        plugins["entries"] = entries
        output["plugins"] = plugins
        return output
    }

    private static func mergeMissing(existing: [String: Any], defaults: [String: Any]) -> [String: Any] {
        var output = existing
        for (key, value) in defaults where !output.keys.contains(key) { output[key] = value }
        for (key, value) in defaults {
            guard let nestedDefaults = value as? [String: Any],
                  let nestedExisting = output[key] as? [String: Any]
            else { continue }
            output[key] = mergeMissing(existing: nestedExisting, defaults: nestedDefaults)
        }
        return output
    }
}
