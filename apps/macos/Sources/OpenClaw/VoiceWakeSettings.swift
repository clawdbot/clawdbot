import AppKit
import AVFoundation
import Observation
import Speech
import SwabbleKit
import SwiftUI
import UniformTypeIdentifiers

struct VoiceWakeSettings: View {
    @Bindable var state: AppState
    let isActive: Bool
    @State private var testState: VoiceWakeTestState = .idle
    @State private var tester = VoiceWakeTester()
    @State private var isTesting = false
    @State private var testTimeoutTask: Task<Void, Never>?
    @State private var availableMics: [AudioInputDevice] = []
    @State private var loadingMics = false
    @State private var meterLevel: Double = 0
    @State private var meterError: String?
    private let meter = MicLevelMonitor()
    @State private var micObserver = AudioInputDeviceObserver()
    @State private var micRefreshTask: Task<Void, Never>?
    @State private var meterStartupTask: Task<Void, Never>?
    @State private var availableLocales: [Locale] = []
    @State private var triggerEntries: [TriggerEntry] = []
    private let controlWidth: CGFloat = 240
    private let isPreview = ProcessInfo.processInfo.isPreview

    private struct AudioInputDevice: Identifiable, Equatable {
        let uid: String
        let name: String
        var id: String {
            self.uid
        }
    }

    private struct TriggerEntry: Identifiable {
        let id: UUID
        var value: String
    }

    private var voiceWakeBinding: Binding<Bool> {
        MicRefreshSupport.voiceWakeBinding(for: self.state)
    }

    private var selectedLocaleSupportsOnDeviceRecognition: Bool {
        SpeechRecognitionRequestPolicy.supportsPassiveVoiceWake(localeID: self.state.voiceWakeLocaleID)
    }

    private var voiceSummaryPanel: some View {
        let enabled = voiceWakeSupported && self.state.swabbleEnabled
        let pushToTalk = voiceWakeSupported && self.state.voicePushToTalkEnabled
        let statusColor: Color = !voiceWakeSupported ? .orange : enabled || pushToTalk ? .green : .secondary

        return HStack(alignment: .center, spacing: 14) {
            ZStack {
                Circle()
                    .fill(statusColor.opacity(0.18))
                Image(systemName: self.voiceSummaryIconName(enabled: enabled))
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(statusColor)
            }
            .frame(width: 46, height: 46)

            VStack(alignment: .leading, spacing: 4) {
                Text(self.voiceSummaryTitle(enabled: enabled, pushToTalk: pushToTalk))
                    .font(.headline)
                Text(self.voiceSummarySubtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 18)

            if let meterError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .help(meterError)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.white.opacity(0.06))
        }
    }

    private func voiceSummaryIconName(enabled: Bool) -> String {
        if !voiceWakeSupported {
            return "exclamationmark.triangle.fill"
        }
        return enabled ? "waveform.badge.mic" : "mic.slash"
    }

    private func voiceSummaryTitle(enabled: Bool, pushToTalk: Bool) -> String {
        if !voiceWakeSupported {
            return "Voice Wake unavailable"
        }
        if enabled {
            return "Voice Wake active"
        }
        if pushToTalk {
            return "Push-to-talk active"
        }
        return "Voice controls idle"
    }

    private var voiceSummarySubtitle: String {
        if !voiceWakeSupported {
            return "Voice Wake requires macOS 26 or newer."
        }
        if self.state.swabbleEnabled {
            return "Listening for \(self.sanitizedTriggers().prefix(2).joined(separator: ", "))."
        }
        if self.state.voicePushToTalkEnabled {
            return "Hold Right Option to speak without a wake phrase."
        }
        return "Enable Voice Wake or push-to-talk to start voice commands."
    }

    private var unsupportedVoiceWakePanel: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.orange)
                .frame(width: 28)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 4) {
                Text("Voice Wake requires macOS 26 or newer")
                    .font(.callout.weight(.semibold))
                Text("The Voice Wake and push-to-talk controls are hidden on older macOS versions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.orange.opacity(0.18))
        }
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                SettingsPageHeader(
                    title: "Voice & Talk",
                    subtitle: "Wake phrases, push-to-talk, microphone input, and Talk Mode feedback.")

                self.voiceSummaryPanel

                if voiceWakeSupported {
                    SettingsCardGroup("Activation") {
                        SettingsCardToggleRow(
                            title: "Enable Voice Wake",
                            subtitle: self.selectedLocaleSupportsOnDeviceRecognition
                                ? """
                                Listen for a wake phrase before running voice commands. \
                                Wake-phrase recognition stays on this Mac.
                                """
                                : "On-device recognition is unavailable for the selected language on this Mac.",
                            binding: self.voiceWakeBinding)
                            .disabled(!self.selectedLocaleSupportsOnDeviceRecognition && !self.state.swabbleEnabled)

                        SettingsCardToggleRow(
                            title: "Trigger Talk Mode",
                            subtitle: "Start a full voice conversation when a wake phrase is detected.",
                            binding: self.$state.voiceWakeTriggersTalkMode)
                            .disabled(!self.state.swabbleEnabled)

                        SettingsCardToggleRow(
                            title: "Hold Right Option to talk",
                            subtitle: "Start listening while you hold the key and show the preview overlay.",
                            binding: self.$state.voicePushToTalkEnabled)

                        if self.state.voicePushToTalkEnabled, self.state.talkEnabled {
                            SettingsCardRow(
                                title: "Push-to-talk paused",
                                subtitle: "Push-to-Talk resumes when Talk Mode is turned off.")
                            {
                                Image(systemName: "pause.circle.fill")
                                    .foregroundStyle(.orange)
                            }
                        }

                        SettingsCardToggleRow(
                            title: "Play phase-transition sounds",
                            subtitle: """
                            Play short sounds when Talk Mode switches between listening, thinking, and speaking.
                            """,
                            binding: self.$state.talkPhaseSoundsEnabled)

                        SettingsCardToggleRow(
                            title: "Right Option stops speech",
                            subtitle: "Tap Right Option to interrupt speech and return to listening.",
                            binding: self.$state.talkShiftToStopEnabled,
                            showsDivider: false)
                    }

                    SettingsCardGroup("Recognition") {
                        self.localePicker
                        self.micPicker
                        self.levelMeter
                    }

                    SettingsCardGroup("Test") {
                        VoiceWakeTestCard(
                            testState: self.$testState,
                            isTesting: self.$isTesting,
                            onToggle: self.toggleTest)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                    }

                    self.chimeSection

                    self.triggerTable
                } else {
                    self.unsupportedVoiceWakePanel
                }

                Spacer(minLength: 8)
            }
            .settingsDetailContent()
        }
        .onAppear {
            guard !self.isPreview else { return }
            guard self.isActive else { return }
            self.activateLivePreview()
        }
        .onChange(of: self.state.voiceWakeMicID) { _, _ in
            guard !self.isPreview else { return }
            self.updateSelectedMicName()
            guard self.isActive else { return }
            self.scheduleMeterRestart()
        }
        .onChange(of: self.isActive) { _, active in
            guard !self.isPreview else { return }
            if !active {
                self.deactivateLivePreview()
                self.syncTriggerEntriesToState()
            } else {
                self.activateLivePreview()
            }
        }
        .onDisappear {
            guard !self.isPreview else { return }
            self.deactivateLivePreview()
            self.syncTriggerEntriesToState()
        }
    }

    private func activateLivePreview() {
        self.loadTriggerEntries()
        guard voiceWakeSupported else {
            self.deactivateLivePreview()
            return
        }
        self.meterStartupTask?.cancel()
        self.startMicObserver()
        self.meterStartupTask = Task { @MainActor in
            await self.loadMicsIfNeeded()
            guard !Task.isCancelled, self.isActive else { return }
            await self.loadLocalesIfNeeded()
            guard !Task.isCancelled, self.isActive else { return }
            await self.restartMeter()
        }
    }

    private func deactivateLivePreview() {
        self.tester.stop()
        self.isTesting = false
        self.testState = .idle
        self.testTimeoutTask?.cancel()
        self.micRefreshTask?.cancel()
        self.micRefreshTask = nil
        self.meterStartupTask?.cancel()
        self.meterStartupTask = nil
        self.micObserver.stop()
        self.state.voiceWakeMeterActive = false
        Task { await self.meter.stop() }
    }

    private func scheduleMeterRestart() {
        guard voiceWakeSupported else {
            self.state.voiceWakeMeterActive = false
            Task { await self.meter.stop() }
            return
        }
        self.meterStartupTask?.cancel()
        self.meterStartupTask = Task { @MainActor in
            guard !Task.isCancelled, self.isActive else { return }
            await self.restartMeter()
        }
    }

    private func loadTriggerEntries() {
        self.triggerEntries = self.state.swabbleTriggerWords.map { TriggerEntry(id: UUID(), value: $0) }
    }

    private func syncTriggerEntriesToState() {
        self.state.swabbleTriggerWords = self.triggerEntries.map(\.value)
    }

    private var triggerTable: some View {
        SettingsCardGroup("Trigger Words") {
            SettingsCardRow(
                title: "Wake phrases",
                subtitle: "Short phrases that start voice wake detection.")
            {
                HStack(spacing: 8) {
                    Button {
                        self.addWord()
                    } label: {
                        Label("Add word", systemImage: "plus")
                    }
                    .disabled(self.triggerEntries
                        .contains(where: { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }))

                    Button("Reset") {
                        self.triggerEntries = defaultVoiceWakeTriggers.map { TriggerEntry(id: UUID(), value: $0) }
                        self.syncTriggerEntriesToState()
                    }
                }
                .buttonStyle(.bordered)
            }

            self.triggerPhraseRows

            TriggerPhraseHelpRow()
        }
    }

    private var triggerPhraseRows: some View {
        Group {
            if self.triggerEntries.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "text.badge.plus")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(width: 22)
                    Text("No wake phrases configured")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
            } else {
                VStack(spacing: 0) {
                    ForEach(self.$triggerEntries) { $entry in
                        TriggerPhraseRow(
                            value: $entry.value,
                            showsDivider: entry.id != self.triggerEntries.last?.id,
                            onSubmit: {
                                self.syncTriggerEntriesToState()
                            },
                            onRemove: {
                                self.removeWord(id: entry.id)
                            })
                    }
                }
            }
        }
        .overlay(alignment: .bottom) {
            Divider()
                .padding(.leading, 14)
        }
    }

    private var chimeSection: some View {
        SettingsCardGroup("Sounds") {
            self.chimeRow(
                title: "Trigger sound",
                selection: self.$state.voiceWakeTriggerChime)

            self.chimeRow(
                title: "Send sound",
                selection: self.$state.voiceWakeSendChime,
                showsDivider: false)
        }
    }

    private func addWord() {
        self.triggerEntries.append(TriggerEntry(id: UUID(), value: ""))
    }

    private func removeWord(id: UUID) {
        self.triggerEntries.removeAll { $0.id == id }
        self.syncTriggerEntriesToState()
    }

    private func toggleTest() {
        guard voiceWakeSupported else {
            self.testState = .failed("Voice Wake requires macOS 26 or newer.")
            return
        }
        if self.isTesting {
            self.tester.finalize()
            self.isTesting = false
            self.testState = .finalizing
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if self.testState == .finalizing {
                    self.tester.stop()
                    self.testState = .failed("Stopped")
                }
            }
            self.testTimeoutTask?.cancel()
            return
        }

        let triggers = self.sanitizedTriggers()
        self.tester.stop()
        self.testTimeoutTask?.cancel()
        self.isTesting = true
        self.testState = .requesting
        Task { @MainActor in
            do {
                try await self.tester.start(
                    triggers: triggers,
                    micID: self.state.voiceWakeMicID.isEmpty ? nil : self.state.voiceWakeMicID,
                    localeID: self.state.voiceWakeLocaleID,
                    onUpdate: { newState in
                        DispatchQueue.main.async { [self] in
                            self.testState = newState
                            if case .detected = newState { self.isTesting = false }
                            if case .failed = newState { self.isTesting = false }
                            if case .detected = newState { self.testTimeoutTask?.cancel() }
                            if case .failed = newState { self.testTimeoutTask?.cancel() }
                        }
                    })
                self.testTimeoutTask?.cancel()
                self.testTimeoutTask = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 10 * 1_000_000_000)
                    guard !Task.isCancelled else { return }
                    if self.isTesting {
                        self.tester.stop()
                        if case let .hearing(text) = self.testState,
                           let command = Self.textOnlyCommand(from: text, triggers: triggers)
                        {
                            self.testState = .detected(command)
                        } else {
                            self.testState = .failed("Timeout: no trigger heard")
                        }
                        self.isTesting = false
                    }
                }
            } catch {
                self.tester.stop()
                self.testState = .failed(error.localizedDescription)
                self.isTesting = false
                self.testTimeoutTask?.cancel()
            }
        }
    }

    private func chimeRow(
        title: SettingsTextValue,
        selection: Binding<VoiceWakeChime>,
        showsDivider: Bool = true) -> some View
    {
        SettingsCardRow(title: title, showsDivider: showsDivider) {
            Menu {
                Button("No Sound") { self.selectChime(.none, binding: selection) }
                Divider()
                ForEach(VoiceWakeChimeCatalog.systemOptions, id: \.self) { option in
                    Button(VoiceWakeChimeCatalog.displayName(for: option)) {
                        self.selectChime(.system(name: option), binding: selection)
                    }
                }
                Divider()
                Button("Choose file…") { self.chooseCustomChime(for: selection) }
            } label: {
                HStack(spacing: 6) {
                    Text(selection.wrappedValue.displayLabel)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(6)
                .frame(width: self.controlWidth, alignment: .leading)
                .background(Color(nsColor: .windowBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.25), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            Button("Play") {
                VoiceWakeChimePlayer.play(selection.wrappedValue)
            }
            .keyboardShortcut(.space, modifiers: [.command])
        }
    }

    private func chooseCustomChime(for selection: Binding<VoiceWakeChime>) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audio]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.resolvesAliases = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let bookmark = try url.bookmarkData(
                    options: [.withSecurityScope],
                    includingResourceValuesForKeys: nil,
                    relativeTo: nil)
                let chosen = VoiceWakeChime.custom(displayName: url.lastPathComponent, bookmark: bookmark)
                selection.wrappedValue = chosen
                VoiceWakeChimePlayer.play(chosen)
            } catch {
                // Ignore failures; user can retry.
            }
        }
    }

    private func selectChime(_ chime: VoiceWakeChime, binding: Binding<VoiceWakeChime>) {
        binding.wrappedValue = chime
        VoiceWakeChimePlayer.play(chime)
    }

    private func sanitizedTriggers() -> [String] {
        sanitizeVoiceWakeTriggers(self.state.swabbleTriggerWords)
    }

    private static func textOnlyCommand(from transcript: String, triggers: [String]) -> String? {
        VoiceWakeTextUtils.textOnlyCommand(
            transcript: transcript,
            triggers: triggers,
            minCommandLength: 1,
            trimWake: { WakeWordGate.stripWake(text: $0, triggers: $1) })
    }

    private var micPicker: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsCardRow(title: "Microphone") {
                Picker("Microphone", selection: self.$state.voiceWakeMicID) {
                    Text("System default").tag("")
                    if self.isSelectedMicUnavailable {
                        Text(self.state.voiceWakeMicName.isEmpty ? "Unavailable" : self.state.voiceWakeMicName)
                            .tag(self.state.voiceWakeMicID)
                    }
                    ForEach(self.availableMics) { mic in
                        Text(mic.name).tag(mic.uid)
                    }
                }
                .labelsHidden()
                .frame(width: self.controlWidth)
            }
            if self.isSelectedMicUnavailable {
                Text("Disconnected (using System default)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
            }
            if self.loadingMics {
                ProgressView()
                    .controlSize(.small)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
            }
        }
    }

    private var localePicker: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsCardRow(
                title: "Recognition language",
                subtitle: "Languages are tried in order. Models may need a first-use download on macOS 26.")
            {
                Picker("Language", selection: self.$state.voiceWakeLocaleID) {
                    let current = Locale(identifier: Locale.current.identifier)
                    Text("\(self.friendlyName(for: current)) (System)").tag(Locale.current.identifier)
                    ForEach(self.availableLocales.map(\.identifier), id: \.self) { id in
                        if id != Locale.current.identifier {
                            Text(self.friendlyName(for: Locale(identifier: id))).tag(id)
                        }
                    }
                }
                .labelsHidden()
                .frame(width: self.controlWidth)
            }

            if !self.selectedLocaleSupportsOnDeviceRecognition {
                Text("""
                Voice Wake needs on-device recognition for its selected language. \
                Push-to-talk and Talk Mode remain available.
                """)
                .font(.footnote)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.bottom, 10)
            }

            SettingsCardRow(
                title: "Additional languages",
                subtitle: self.additionalLanguagesSubtitle,
                showsDivider: !self.state.voiceWakeAdditionalLocaleIDs.isEmpty)
            {
                if self.state.voiceWakeAdditionalLocaleIDs.isEmpty {
                    Button {
                        self.addAdditionalLocale()
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.availableLocales.isEmpty)
                }
            }

            if !self.state.voiceWakeAdditionalLocaleIDs.isEmpty {
                self.additionalLanguageRows
            }
        }
    }

    private var additionalLanguagesSubtitle: SettingsTextValue {
        if self.state.voiceWakeAdditionalLocaleIDs.isEmpty {
            return "None configured."
        }
        return "Tried after the primary language."
    }

    private var additionalLanguageRows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(self.state.voiceWakeAdditionalLocaleIDs.enumerated()), id: \.offset) { idx, localeID in
                AdditionalLanguageRow(
                    index: idx,
                    selection: self.additionalLocaleBinding(index: idx, fallback: localeID),
                    localeIDs: self.availableLocales.map(\.identifier),
                    localeName: { id in self.friendlyName(for: Locale(identifier: id)) },
                    showsDivider: true,
                    onRemove: {
                        guard self.state.voiceWakeAdditionalLocaleIDs.indices.contains(idx) else { return }
                        self.state.voiceWakeAdditionalLocaleIDs.remove(at: idx)
                    })
            }

            SettingsCardRow(title: "Add another language", showsDivider: false) {
                Button {
                    self.addAdditionalLocale()
                } label: {
                    Label("Add", systemImage: "plus")
                }
                .buttonStyle(.bordered)
                .disabled(self.availableLocales.isEmpty)
            }
        }
    }

    private func additionalLocaleBinding(index: Int, fallback: String) -> Binding<String> {
        Binding(
            get: {
                guard self.state.voiceWakeAdditionalLocaleIDs.indices.contains(index) else { return fallback }
                return self.state.voiceWakeAdditionalLocaleIDs[index]
            },
            set: { newValue in
                guard self.state.voiceWakeAdditionalLocaleIDs.indices.contains(index) else { return }
                self.state.voiceWakeAdditionalLocaleIDs[index] = newValue
            })
    }

    private func addAdditionalLocale() {
        let selected = Set([self.state.voiceWakeLocaleID] + self.state.voiceWakeAdditionalLocaleIDs)
        let next = self.availableLocales.first { !selected.contains($0.identifier) } ?? self.availableLocales.first
        if let next {
            self.state.voiceWakeAdditionalLocaleIDs.append(next.identifier)
        }
    }

    @MainActor
    private func loadMicsIfNeeded(force: Bool = false) async {
        guard force || self.availableMics.isEmpty, !self.loadingMics else { return }
        self.loadingMics = true
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external, .microphone],
            mediaType: .audio,
            position: .unspecified)
        let aliveUIDs = AudioInputDeviceObserver.aliveInputDeviceUIDs()
        let connectedDevices = discovery.devices.filter(\.isConnected)
        let devices = aliveUIDs.isEmpty
            ? connectedDevices
            : connectedDevices.filter { aliveUIDs.contains($0.uniqueID) }
        self.availableMics = devices.map { AudioInputDevice(uid: $0.uniqueID, name: $0.localizedName) }
        self.updateSelectedMicName()
        self.loadingMics = false
    }

    private var isSelectedMicUnavailable: Bool {
        let selected = self.state.voiceWakeMicID
        guard !selected.isEmpty else { return false }
        return !self.availableMics.contains(where: { $0.uid == selected })
    }

    @MainActor
    private func updateSelectedMicName() {
        self.state.voiceWakeMicName = MicRefreshSupport.selectedMicName(
            selectedID: self.state.voiceWakeMicID,
            in: self.availableMics,
            uid: \.uid,
            name: \.name)
    }

    private func startMicObserver() {
        MicRefreshSupport.startObserver(self.micObserver) {
            self.scheduleMicRefresh()
        }
    }

    @MainActor
    private func scheduleMicRefresh() {
        guard voiceWakeSupported, self.isActive else { return }
        MicRefreshSupport.schedule(refreshTask: &self.micRefreshTask) {
            await self.loadMicsIfNeeded(force: true)
            await self.restartMeter()
        }
    }

    @MainActor
    private func loadLocalesIfNeeded() async {
        guard self.availableLocales.isEmpty else { return }
        self.availableLocales = Array(SFSpeechRecognizer.supportedLocales()).sorted { lhs, rhs in
            self.friendlyName(for: lhs)
                .localizedCaseInsensitiveCompare(self.friendlyName(for: rhs)) == .orderedAscending
        }
    }

    private func friendlyName(for locale: Locale) -> String {
        let cleanedID = normalizeLocaleIdentifier(locale.identifier)
        let cleanLocale = Locale(identifier: cleanedID)

        if let langCode = cleanLocale.language.languageCode?.identifier,
           let lang = cleanLocale.localizedString(forLanguageCode: langCode),
           let regionCode = cleanLocale.region?.identifier,
           let region = cleanLocale.localizedString(forRegionCode: regionCode)
        {
            return "\(lang) (\(region))"
        }
        if let langCode = cleanLocale.language.languageCode?.identifier,
           let lang = cleanLocale.localizedString(forLanguageCode: langCode)
        {
            return lang
        }
        return cleanLocale.localizedString(forIdentifier: cleanedID) ?? cleanedID
    }

    private var levelMeter: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsCardRow(title: "Live level", showsDivider: false) {
                MicLevelBar(level: self.meterLevel)
                    .frame(width: self.controlWidth, alignment: .leading)
                Text(self.levelLabel)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 60, alignment: .trailing)
            }
            if let meterError {
                Text(meterError)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
            }
        }
    }

    private var levelLabel: String {
        let db = (meterLevel * 50) - 50
        return String(format: "%.0f dB", db)
    }

    @MainActor
    private func restartMeter() async {
        guard voiceWakeSupported else {
            self.state.voiceWakeMeterActive = false
            await self.meter.stop()
            return
        }
        guard self.isActive else {
            self.state.voiceWakeMeterActive = false
            await self.meter.stop()
            return
        }
        self.meterError = nil
        await self.meter.stop()
        guard !Task.isCancelled, self.isActive else {
            self.state.voiceWakeMeterActive = false
            return
        }
        do {
            try await self.meter.start { [weak state] level in
                Task { @MainActor in
                    guard state != nil else { return }
                    self.meterLevel = level
                }
            }
            guard !Task.isCancelled, self.isActive else {
                self.state.voiceWakeMeterActive = false
                await self.meter.stop()
                return
            }
            self.state.voiceWakeMeterActive = true
        } catch {
            self.state.voiceWakeMeterActive = false
            self.meterError = error.localizedDescription
        }
    }
}

private struct TriggerPhraseRow: View {
    @Binding var value: String
    let showsDivider: Bool
    let onSubmit: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "quote.opening")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 24)

            TextField("Wake phrase", text: self.$value)
                .textFieldStyle(.roundedBorder)
                .font(.callout.weight(.medium))
                .frame(maxWidth: 420)
                .onSubmit(self.onSubmit)

            Spacer(minLength: 8)

            Button(action: self.onRemove) {
                Image(systemName: "trash")
                    .font(.callout)
                    .symbolRenderingMode(.hierarchical)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .frame(width: 26, height: 26)
            .contentShape(Rectangle())
            .help("Remove trigger word")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            if self.showsDivider {
                Divider()
                    .padding(.leading, 50)
            }
        }
    }
}

private struct AdditionalLanguageRow: View {
    let index: Int
    @Binding var selection: String
    let localeIDs: [String]
    let localeName: (String) -> String
    let showsDivider: Bool
    let onRemove: () -> Void

    var body: some View {
        SettingsCardRow(
            title: .verbatim(String(
                format: String(localized: "Language %lld"),
                self.index + 2)),
            subtitle: "Fallback recognition language.",
            showsDivider: self.showsDivider)
        {
            HStack(spacing: 10) {
                Picker("Language \(self.index + 2)", selection: self.$selection) {
                    ForEach(self.localeIDs, id: \.self) { id in
                        Text(self.localeName(id)).tag(id)
                    }
                }
                .labelsHidden()
                .frame(width: 220)

                Button(action: self.onRemove) {
                    Image(systemName: "trash")
                        .font(.callout)
                        .symbolRenderingMode(.hierarchical)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
                .help("Remove language")
            }
        }
    }
}

private struct TriggerPhraseHelpRow: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 18)
                .padding(.top, 1)

            Text(
                "OpenClaw reacts when any trigger appears in a transcription. " +
                    "Keep phrases short to avoid false positives.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

#if DEBUG
struct VoiceWakeSettings_Previews: PreviewProvider {
    static var previews: some View {
        VoiceWakeSettings(state: .preview, isActive: true)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}

@MainActor
extension VoiceWakeSettings {
    static func exerciseForTesting() {
        let state = AppState(preview: true)
        state.swabbleEnabled = true
        state.voicePushToTalkEnabled = true
        state.swabbleTriggerWords = ["Claude", "Hey"]

        let view = VoiceWakeSettings(state: state, isActive: true)
        view.availableMics = [AudioInputDevice(uid: "mic-1", name: "Built-in")]
        view.availableLocales = [Locale(identifier: "en_US")]
        view.meterLevel = 0.42
        view.meterError = "No input"
        view.testState = .detected("ok")
        view.isTesting = true
        view.triggerEntries = [TriggerEntry(id: UUID(), value: "Claude")]

        _ = view.body
        _ = view.localePicker
        _ = view.micPicker
        _ = view.levelMeter
        _ = view.triggerTable
        _ = view.chimeSection
        _ = view.unsupportedVoiceWakePanel

        view.addWord()
        if let entryId = view.triggerEntries.first?.id {
            view.removeWord(id: entryId)
        }
    }
}
#endif
