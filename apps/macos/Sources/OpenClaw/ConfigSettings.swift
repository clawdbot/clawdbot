import SwiftUI

@MainActor
struct ConfigSettings: View {
    private let isPreview = ProcessInfo.processInfo.isPreview
    private let isNixMode = ProcessInfo.processInfo.isNixMode
    @Bindable var store: ChannelsStore
    @State private var hasLoaded = false
    @State private var activePath: String?
    @State private var failedLookupPaths: Set<String> = []

    init(store: ChannelsStore = .shared) {
        self.store = store
    }

    var body: some View {
        HStack(spacing: 16) {
            self.sidebar
            self.detail
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task {
            guard !self.hasLoaded else { return }
            guard !self.isPreview else { return }
            self.hasLoaded = true
            Task { await self.store.loadConfig(force: false) }
            _ = await self.store.loadConfigSchemaLookup(path: ".")
            self.ensureSelection()
        }
        .task(id: self.activePath) {
            guard let activePath = self.activePath else { return }
            await self.loadPath(activePath)
        }
        .onAppear { self.ensureSelection() }
        .onChange(of: self.store.configLookupRoot?.path) { _, _ in
            self.failedLookupPaths.removeAll()
            self.ensureSelection()
        }
    }
}

extension ConfigSettings {
    private struct ConfigSection: Identifiable {
        let key: String
        let label: String
        let help: String?
        let path: String
        let hasChildren: Bool

        var id: String {
            self.path
        }
    }

    private struct ConfigSubsection: Identifiable {
        let key: String
        let label: String
        let help: String?
        let path: String
        let hasChildren: Bool

        var id: String {
            self.path
        }
    }

    private var sections: [ConfigSection] {
        guard let root = self.store.configLookupRoot else { return [] }
        return self.resolveSections(root.children)
    }

    private var activeSection: ConfigSection? {
        guard let activePath = self.activePath else { return nil }
        return self.sections.first { activePath == $0.path || activePath.hasPrefix("\($0.path).") }
    }

    private var sidebar: some View {
        SettingsSidebarScroll {
            LazyVStack(alignment: .leading, spacing: 4) {
                if self.sections.isEmpty {
                    Text("No config sections available.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                } else {
                    ForEach(self.sections) { section in
                        self.sidebarSection(section)
                    }
                }
            }
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 16) {
            if self.store.configLookupRoot == nil,
               !self.hasLoaded || self.store.configLookupLoadingPaths.contains(".")
            {
                ProgressView().controlSize(.small)
            } else if let section = self.activeSection {
                self.sectionDetail(section)
            } else if self.store.configLookupRoot != nil {
                self.emptyDetail
            } else {
                self.schemaUnavailableDetail
            }
        }
        .frame(minWidth: 460, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var emptyDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            self.header
            Text("Select a config section to view settings.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }

    private var schemaUnavailableDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            self.header
            Text(self.store.configStatus ?? "Schema unavailable.")
                .font(.callout)
                .foregroundStyle(.secondary)
            self.actionRow
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }

    private func sectionDetail(_ section: ConfigSection) -> some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                self.header
                if let status = self.store.configStatus {
                    Text(status)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                self.actionRow
                self.sectionHeader(section)
                self.sectionForm(section)
                if self.store.configDirty, !self.isNixMode {
                    Text("Unsaved changes")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.vertical, 18)
            .groupBoxStyle(PlainSettingsGroupBoxStyle())
        }
    }

    @ViewBuilder
    private var header: some View {
        Text("Config")
            .font(.title3.weight(.semibold))
        Text(self.isNixMode
            ? "This tab is read-only in Nix mode. Edit config via Nix and rebuild."
            : "Edit ~/.openclaw/openclaw.json using the schema-driven form.")
            .font(.callout)
            .foregroundStyle(.secondary)
    }

    private func sectionHeader(_ section: ConfigSection) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(section.label)
                .font(.title3.weight(.semibold))
            if let help = section.help {
                Text(help)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            Button("Reload") {
                Task { await self.store.reloadConfigDraft() }
            }
            .disabled(!self.store.configLoaded)

            Button(self.store.isSavingConfig ? "Saving…" : "Save") {
                Task { await self.store.saveConfigDraft() }
            }
            .disabled(self.isNixMode || self.store.isSavingConfig || !self.store.configLoaded || !self.store
                .configDirty)
        }
        .buttonStyle(.bordered)
    }

    private func sidebarSection(_ section: ConfigSection) -> some View {
        let isExpanded = self.activePath == section.path || self.activePath?.hasPrefix("\(section.path).") == true
        let subsections = isExpanded ? self.resolveSubsections(for: section) : []

        return VStack(alignment: .leading, spacing: 2) {
            Button {
                self.selectSection(section)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Text(section.label)
                        .lineLimit(1)
                }
                .padding(.vertical, 5)
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(self.activePath == section.path
                    ? Color.accentColor.opacity(0.18)
                    : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contentShape(Rectangle())

            if isExpanded, !subsections.isEmpty {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(subsections) { sub in
                        self.sidebarSubRow(sub)
                    }
                }
                .padding(.leading, 20)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.easeInOut(duration: 0.18), value: isExpanded)
    }

    private func sidebarSubRow(_ subsection: ConfigSubsection) -> some View {
        let isSelected = self.activePath == subsection.path
        return Button {
            self.selectPath(subsection.path)
        } label: {
            Text(subsection.label)
                .font(.callout)
                .lineLimit(1)
                .padding(.vertical, 4)
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isSelected ? Color.accentColor.opacity(0.18) : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
    }

    private func sectionForm(_ section: ConfigSection) -> some View {
        let path = self.activePath ?? section.path
        if self.store.configLookupLoadingPaths.contains(path) {
            return AnyView(ProgressView().controlSize(.small))
        }
        guard let node = self.store.configLookupNode(path: path) else {
            if self.failedLookupPaths.contains(path) {
                return AnyView(self.lookupUnavailable(path: path))
            }
            return AnyView(ProgressView().controlSize(.small))
        }
        if !node.children.isEmpty, !Self.shouldRenderFormEditor(for: node.schema) {
            return AnyView(self.lookupChildrenList(node))
        }
        guard self.store.configLoaded else {
            return AnyView(
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading current values…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                })
        }
        guard let configPath = Self.configPath(from: node.path) else {
            return AnyView(
                Text("Wildcard config entries are edited from their concrete key.")
                    .font(.caption)
                    .foregroundStyle(.secondary))
        }
        return AnyView(
            ConfigSchemaForm(store: self.store, schema: node.schema, path: configPath)
                .disabled(self.isNixMode))
    }

    private func ensureSelection() {
        let sections = self.sections
        guard !sections.isEmpty else { return }

        if let activePath = self.activePath,
           sections.contains(where: { activePath == $0.path || activePath.hasPrefix("\($0.path).") })
        {
            return
        }

        self.selectSection(sections[0])
    }

    private func selectSection(_ section: ConfigSection) {
        self.activePath = section.path
    }

    private func selectPath(_ path: String) {
        self.activePath = path
    }

    private func lookupUnavailable(path: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(self.store.configStatus ?? "Schema unavailable.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button("Retry") {
                self.failedLookupPaths.remove(path)
                Task { await self.loadPath(path) }
            }
            .buttonStyle(.bordered)
        }
    }

    private func lookupChildrenList(_ node: ConfigSchemaLookupNode) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(node.children) { child in
                Button {
                    self.selectPath(child.path)
                } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(self.label(for: child))
                                .font(.callout.weight(.semibold))
                            if let help = child.hint?.help {
                                Text(help)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            } else if let type = child.typeLabel {
                                Text(type)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if child.required {
                            Text("Required")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Image(systemName: child.hasChildren ? "chevron.right" : "slider.horizontal.3")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 8)
                    .padding(.horizontal, 10)
                    .background(Color.primary.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func resolveSections(_ children: [ConfigSchemaLookupChild]) -> [ConfigSection] {
        children
            .sorted(by: self.sortLookupChildren)
            .map { child in
                ConfigSection(
                    key: child.key,
                    label: self.label(for: child),
                    help: child.hint?.help,
                    path: child.path,
                    hasChildren: child.hasChildren)
            }
    }

    private func resolveSubsections(for section: ConfigSection) -> [ConfigSubsection] {
        guard let node = self.store.configLookupNode(path: section.path) else {
            return []
        }
        return node.children
            .sorted(by: self.sortLookupChildren)
            .map { child in
                ConfigSubsection(
                    key: child.key,
                    label: self.label(for: child),
                    help: child.hint?.help,
                    path: child.path,
                    hasChildren: child.hasChildren)
            }
    }

    private func loadPath(_ path: String) async {
        guard self.store.configLookupNode(path: path) == nil else {
            self.failedLookupPaths.remove(path)
            return
        }
        guard !self.store.configLookupLoadingPaths.contains(path) else { return }
        if await self.store.loadConfigSchemaLookup(path: path) == nil {
            self.failedLookupPaths.insert(path)
        } else {
            self.failedLookupPaths.remove(path)
        }
    }

    private func label(for child: ConfigSchemaLookupChild) -> String {
        child.hint?.label
            ?? self.humanize(child.key)
    }

    private func sortLookupChildren(_ lhs: ConfigSchemaLookupChild, _ rhs: ConfigSchemaLookupChild) -> Bool {
        let orderA = lhs.hint?.order ?? 0
        let orderB = rhs.hint?.order ?? 0
        if orderA != orderB { return orderA < orderB }
        return lhs.key < rhs.key
    }

    private static func configPath(from lookupPath: String) -> ConfigPath? {
        guard lookupPath != "." else { return [] }
        let normalized = lookupPath
            .replacingOccurrences(of: "[", with: ".")
            .replacingOccurrences(of: "]", with: "")
        let parts = normalized
            .split(separator: ".")
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !parts.contains("*") else { return nil }
        return parts.map { part in
            if let index = Int(part) {
                return .index(index)
            }
            return .key(part)
        }
    }

    private static func shouldRenderFormEditor(for schema: ConfigSchemaNode) -> Bool {
        if schema.schemaType == "array" { return true }
        return schema.additionalProperties != nil
    }

    private func humanize(_ key: String) -> String {
        key.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }
}

struct ConfigSettings_Previews: PreviewProvider {
    static var previews: some View {
        ConfigSettings()
    }
}
