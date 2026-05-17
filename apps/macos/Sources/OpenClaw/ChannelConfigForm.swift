import SwiftUI

enum ConfigSchemaFormMode {
    case full
    case channelQuick
}

struct ConfigSchemaForm: View {
    @Bindable var store: ChannelsStore
    let schema: ConfigSchemaNode
    let path: ConfigPath
    let mode: ConfigSchemaFormMode

    init(
        store: ChannelsStore,
        schema: ConfigSchemaNode,
        path: ConfigPath,
        mode: ConfigSchemaFormMode = .full)
    {
        self.store = store
        self.schema = schema
        self.path = path
        self.mode = mode
    }

    var body: some View {
        self.renderNode(self.schema, path: self.path)
    }

    private func renderNode(_ schema: ConfigSchemaNode, path: ConfigPath) -> AnyView {
        let storedValue = self.store.configValue(at: path)
        let value = storedValue ?? schema.explicitDefault
        let label = self.fieldLabel(for: schema, path: path)
        let help = hintForPath(path, hints: store.configUiHints)?.help ?? schema.description
        let variants = schema.anyOf.isEmpty ? schema.oneOf : schema.anyOf

        if !variants.isEmpty {
            let nonNull = variants.filter { !$0.isNullSchema }
            if nonNull.count == 1, let only = nonNull.first {
                return self.renderNode(only, path: path)
            }
            let literals = nonNull.compactMap(\.literalValue)
            if !literals.isEmpty, literals.count == nonNull.count {
                return AnyView(
                    VStack(alignment: .leading, spacing: 6) {
                        if let label { Text(label).font(.callout.weight(.semibold)) }
                        if let help {
                            Text(help)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Picker(
                            "",
                            selection: self.enumBinding(
                                path,
                                options: literals,
                                defaultValue: schema.explicitDefault))
                        {
                            Text("Select…").tag(-1)
                            ForEach(literals.indices, id: \ .self) { index in
                                Text(String(describing: literals[index])).tag(index)
                            }
                        }
                        .pickerStyle(.menu)
                    })
            }
        }

        switch schema.schemaType {
        case "object":
            return AnyView(
                VStack(alignment: .leading, spacing: 12) {
                    if let label {
                        Text(label)
                            .font(.callout.weight(.semibold))
                    }
                    if let help {
                        Text(help)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    let properties = schema.properties
                    let sortedKeys = self.visibleObjectKeys(properties: properties, path: path)
                    ForEach(sortedKeys, id: \ .self) { key in
                        if let child = properties[key] {
                            self.renderNode(child, path: path + [.key(key)])
                        }
                    }
                    if sortedKeys.isEmpty, self.mode == .channelQuick, self.isChannelRoot(path) {
                        self.renderChannelQuickEmptyState()
                    }
                    if self.shouldRenderAdditionalProperties(schema, path: path, value: value) {
                        self.renderAdditionalProperties(schema, path: path, value: value)
                    }
                })
        case "array":
            return AnyView(self.renderArray(schema, path: path, value: value, label: label, help: help))
        case "boolean":
            return AnyView(
                Toggle(isOn: self.boolBinding(path, defaultValue: schema.explicitDefault as? Bool)) {
                    if let label { Text(label) } else { Text("Enabled") }
                }
                .help(help ?? ""))
        case "number", "integer":
            return AnyView(self.renderNumberField(schema, path: path, label: label, help: help))
        case "string":
            return AnyView(self.renderStringField(schema, path: path, label: label, help: help))
        default:
            return AnyView(
                VStack(alignment: .leading, spacing: 6) {
                    if let label { Text(label).font(.callout.weight(.semibold)) }
                    Text("Unsupported field type.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                })
        }
    }

    private func fieldLabel(for schema: ConfigSchemaNode, path: ConfigPath) -> String? {
        hintForPath(path, hints: self.store.configUiHints)?.label
            ?? schema.title
            ?? labelForConfigPath(path)
    }

    private func visibleObjectKeys(
        properties: [String: ConfigSchemaNode],
        path: ConfigPath) -> [String]
    {
        let sortedKeys = properties.keys.sorted { lhs, rhs in
            let orderA = hintForPath(path + [.key(lhs)], hints: store.configUiHints)?.order ?? 0
            let orderB = hintForPath(path + [.key(rhs)], hints: store.configUiHints)?.order ?? 0
            if orderA != orderB { return orderA < orderB }
            return lhs < rhs
        }

        guard self.mode == .channelQuick, self.isChannelRoot(path) else {
            return sortedKeys
        }

        return sortedKeys.filter { key in
            guard let child = properties[key] else { return false }
            return self.shouldRenderChannelQuickField(key: key, schema: child, path: path + [.key(key)])
        }
    }

    private func shouldRenderChannelQuickField(
        key: String,
        schema: ConfigSchemaNode,
        path: ConfigPath) -> Bool
    {
        if hintForPath(path, hints: self.store.configUiHints)?.advanced == true {
            return false
        }
        if Self.channelQuickKeys.contains(key) {
            return self.isSimpleField(schema)
        }
        return self.store.configValue(at: path) != nil && self.isSimpleField(schema)
    }

    private func isSimpleField(_ schema: ConfigSchemaNode) -> Bool {
        let variants = schema.anyOf.isEmpty ? schema.oneOf : schema.anyOf
        let nonNullVariants = variants.filter { !$0.isNullSchema }
        if !nonNullVariants.isEmpty {
            return nonNullVariants.allSatisfy(self.isSimpleField)
        }
        if let enumValues = schema.enumValues {
            return !enumValues.isEmpty
        }
        switch schema.schemaType {
        case "boolean", "integer", "number", "string":
            return true
        default:
            return false
        }
    }

    private func shouldRenderAdditionalProperties(
        _ schema: ConfigSchemaNode,
        path: ConfigPath,
        value: Any?) -> Bool
    {
        guard schema.allowsAdditionalProperties else { return false }
        if self.mode != .channelQuick { return true }
        guard let dict = value as? [String: Any] else { return false }
        let reserved = Set(schema.properties.keys)
        return dict.keys.contains { !reserved.contains($0) }
    }

    private func isChannelRoot(_ path: ConfigPath) -> Bool {
        guard path.count == 2 else { return false }
        guard case .key("channels") = path[0] else { return false }
        guard case .key = path[1] else { return false }
        return true
    }

    private func renderChannelQuickEmptyState() -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No quick settings for this channel.")
                .font(.callout.weight(.semibold))
            Text("Use Config for account, guild, action, and policy details.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private static let channelQuickKeys: Set<String> = [
        "apiHash",
        "apiId",
        "appToken",
        "baseUrl",
        "botToken",
        "configWrites",
        "deviceName",
        "dmPolicy",
        "enabled",
        "groupPolicy",
        "historyLimit",
        "mode",
        "nativeCommands",
        "nativeSkillCommands",
        "phoneNumber",
        "signingSecret",
        "token",
        "url",
        "username",
        "webhookUrl",
    ]

    @ViewBuilder
    private func renderStringField(
        _ schema: ConfigSchemaNode,
        path: ConfigPath,
        label: String?,
        help: String?) -> some View
    {
        let hint = hintForPath(path, hints: store.configUiHints)
        let placeholder = hint?.placeholder ?? ""
        let sensitive = hint?.sensitive ?? isSensitivePath(path)
        let defaultValue = schema.explicitDefault as? String
        VStack(alignment: .leading, spacing: 6) {
            if let label { Text(label).font(.callout.weight(.semibold)) }
            if let help {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let options = schema.enumValues {
                Picker("", selection: self.enumBinding(path, options: options, defaultValue: schema.explicitDefault)) {
                    Text("Select…").tag(-1)
                    ForEach(options.indices, id: \ .self) { index in
                        Text(String(describing: options[index])).tag(index)
                    }
                }
                .pickerStyle(.menu)
            } else if sensitive {
                SecureField(placeholder, text: self.stringBinding(path, defaultValue: defaultValue))
                    .textFieldStyle(.roundedBorder)
            } else {
                TextField(placeholder, text: self.stringBinding(path, defaultValue: defaultValue))
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    @ViewBuilder
    private func renderNumberField(
        _ schema: ConfigSchemaNode,
        path: ConfigPath,
        label: String?,
        help: String?) -> some View
    {
        let defaultValue = (schema.explicitDefault as? Double)
            ?? (schema.explicitDefault as? Int).map(Double.init)
        VStack(alignment: .leading, spacing: 6) {
            if let label { Text(label).font(.callout.weight(.semibold)) }
            if let help {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            TextField(
                "",
                text: self.numberBinding(
                    path,
                    isInteger: schema.schemaType == "integer",
                    defaultValue: defaultValue))
                .textFieldStyle(.roundedBorder)
        }
    }

    @ViewBuilder
    private func renderArray(
        _ schema: ConfigSchemaNode,
        path: ConfigPath,
        value: Any?,
        label: String?,
        help: String?) -> some View
    {
        let items = value as? [Any] ?? []
        let itemSchema = schema.items
        VStack(alignment: .leading, spacing: 10) {
            if let label { Text(label).font(.callout.weight(.semibold)) }
            if let help {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(items.indices, id: \ .self) { index in
                HStack(alignment: .top, spacing: 8) {
                    if let itemSchema {
                        self.renderNode(itemSchema, path: path + [.index(index)])
                    } else {
                        Text(String(describing: items[index]))
                    }
                    Button("Remove") {
                        var next = items
                        next.remove(at: index)
                        self.store.updateConfigValue(path: path, value: next)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
            Button("Add") {
                var next = items
                if let itemSchema {
                    next.append(itemSchema.defaultValue)
                } else {
                    next.append("")
                }
                self.store.updateConfigValue(path: path, value: next)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private func renderAdditionalProperties(
        _ schema: ConfigSchemaNode,
        path: ConfigPath,
        value: Any?) -> some View
    {
        if let additionalSchema = schema.additionalProperties {
            let dict = value as? [String: Any] ?? [:]
            let reserved = Set(schema.properties.keys)
            let extras = dict.keys.filter { !reserved.contains($0) }.sorted()

            VStack(alignment: .leading, spacing: 8) {
                Text("Extra entries")
                    .font(.callout.weight(.semibold))
                if extras.isEmpty {
                    Text("No extra entries yet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(extras, id: \ .self) { key in
                        let itemPath: ConfigPath = path + [.key(key)]
                        HStack(alignment: .top, spacing: 8) {
                            TextField("Key", text: self.mapKeyBinding(path: path, key: key))
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 160)
                            self.renderNode(additionalSchema, path: itemPath)
                            Button("Remove") {
                                var next = dict
                                next.removeValue(forKey: key)
                                self.store.updateConfigValue(path: path, value: next)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
                Button("Add") {
                    var next = dict
                    var index = 1
                    var key = "new-\(index)"
                    while next[key] != nil {
                        index += 1
                        key = "new-\(index)"
                    }
                    next[key] = additionalSchema.defaultValue
                    self.store.updateConfigValue(path: path, value: next)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
    }

    private func stringBinding(_ path: ConfigPath, defaultValue: String?) -> Binding<String> {
        Binding(
            get: {
                if let value = store.configValue(at: path) as? String { return value }
                return defaultValue ?? ""
            },
            set: { newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                self.store.updateConfigValue(path: path, value: trimmed.isEmpty ? nil : trimmed)
            })
    }

    private func boolBinding(_ path: ConfigPath, defaultValue: Bool?) -> Binding<Bool> {
        Binding(
            get: {
                if let value = store.configValue(at: path) as? Bool { return value }
                return defaultValue ?? false
            },
            set: { newValue in
                self.store.updateConfigValue(path: path, value: newValue)
            })
    }

    private func numberBinding(
        _ path: ConfigPath,
        isInteger: Bool,
        defaultValue: Double?) -> Binding<String>
    {
        Binding(
            get: {
                if let value = store.configValue(at: path) { return String(describing: value) }
                guard let defaultValue else { return "" }
                return isInteger ? String(Int(defaultValue)) : String(defaultValue)
            },
            set: { newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty {
                    self.store.updateConfigValue(path: path, value: nil)
                } else if let value = Double(trimmed) {
                    self.store.updateConfigValue(path: path, value: isInteger ? Int(value) : value)
                }
            })
    }

    private func enumBinding(
        _ path: ConfigPath,
        options: [Any],
        defaultValue: Any?) -> Binding<Int>
    {
        Binding(
            get: {
                let value = self.store.configValue(at: path) ?? defaultValue
                guard let value else { return -1 }
                return options.firstIndex { option in
                    String(describing: option) == String(describing: value)
                } ?? -1
            },
            set: { index in
                guard index >= 0, index < options.count else {
                    self.store.updateConfigValue(path: path, value: nil)
                    return
                }
                self.store.updateConfigValue(path: path, value: options[index])
            })
    }

    private func mapKeyBinding(path: ConfigPath, key: String) -> Binding<String> {
        Binding(
            get: { key },
            set: { newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                guard trimmed != key else { return }
                let current = self.store.configValue(at: path) as? [String: Any] ?? [:]
                guard current[trimmed] == nil else { return }
                var next = current
                next[trimmed] = current[key]
                next.removeValue(forKey: key)
                self.store.updateConfigValue(path: path, value: next)
            })
    }
}

struct ChannelConfigForm: View {
    @Bindable var store: ChannelsStore
    let channelId: String

    var body: some View {
        if self.store.configSchemaLoading {
            ProgressView().controlSize(.small)
        } else if let schema = store.channelConfigSchema(for: channelId) {
            ConfigSchemaForm(
                store: self.store,
                schema: schema,
                path: [.key("channels"), .key(self.channelId)],
                mode: .channelQuick)
        } else {
            Text("Schema unavailable for this channel.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
