import MoltbotProtocol
import Observation
import SwiftUI

struct CronJobEditor: View {
    let job: CronJob?
    @Binding var isSaving: Bool
    @Binding var error: String?
    @Bindable var channelsStore: ChannelsStore
    let onCancel: () -> Void
    let onSave: ([String: AnyCodable]) -> Void

    let labelColumnWidth: CGFloat = 160
    static let introText =
        "Create a schedule that wakes clawd via the Gateway. "
            + "Use an isolated session for agent turns so your main chat stays clean."
    static let sessionTargetNote =
        "Main jobs post a system event into the current main session. "
            + "Isolated jobs run clawd in a dedicated session and can deliver results (WhatsApp/Telegram/Discord/etc)."
    static let scheduleKindNote =
        "“At” runs once, “Every” repeats with a duration, “Cron” uses a 5-field Unix expression."
    static let isolatedPayloadNote =
        "Isolated jobs always run an agent turn. The result can be delivered to a channel, "
            + "and a short summary is posted back to your main chat."
    static let mainPayloadNote =
        "System events are injected into the current main session. Agent turns require an isolated session target."
    static let mainSummaryNote =
        "Controls the label used when posting the completion summary back to the main session."

    @State var name: String = ""
    @State var description: String = ""
    @State var agentId: String = ""
    @State var enabled: Bool = true
    @State var sessionTarget: CronSessionTarget = .main
    @State var wakeMode: CronWakeMode = .nextHeartbeat
    @State var deleteAfterRun: Bool = false

    enum ScheduleKind: String, CaseIterable, Identifiable { case at, every, cron; var id: String { rawValue } }
    @State var scheduleKind: ScheduleKind = .every
    @State var atDate: Date = .init().addingTimeInterval(60 * 5)
    @State var everyText: String = "1h"
    @State var cronExpr: String = "0 9 * * 3"
    @State var cronTz: String = ""

    enum PayloadKind: String, CaseIterable, Identifiable { case systemEvent, agentTurn; var id: String { rawValue } }
    @State var payloadKind: PayloadKind = .systemEvent
    @State var systemEventText: String = ""
    @State var agentMessage: String = ""
    @State var deliver: Bool = false
    @State var channel: String = "last"
    @State var to: String = ""
    @State var thinking: String = ""
    @State var timeoutSeconds: String = ""
    @State var bestEffortDeliver: Bool = false
    @State var postPrefix: String = "Cron"

    var channelOptions: [String] {
        let ordered = self.channelsStore.orderedChannelIds()
        var options = ["last"] + ordered
        let trimmed = self.channel.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, !options.contains(trimmed) {
            options.append(trimmed)
        }
        var seen = Set<String>()
        return options.filter { seen.insert($0).inserted }
    }

    func channelLabel(for id: String) -> String {
        if id == "last" { return "last" }
        return self.channelsStore.resolveChannelLabel(id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(self.job == nil ? "New cron job" : "Edit cron job")
                    .font(.title3.weight(.semibold))
                Text(Self.introText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 14) {
                    GroupBox("Basics") {
                        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                            GridRow {
                                self.gridLabel("Name")
                                TextField("Required (e.g. “Daily summary”)", text: self.$name)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(maxWidth: .infinity)
                            }
                            GridRow {
                                self.gridLabel("Description")
                                TextField("Optional notes", text: self.$description)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(maxWidth: .infinity)
                            }
                            GridRow {
                                self.gridLabel("Agent ID")
                                TextField("Optional (default agent)", text: self.$agentId)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(maxWidth: .infinity)
                            }
                            GridRow {
                                self.gridLabel("Enabled")
                                Toggle("", isOn: self.$enabled)
                                    .labelsHidden()
                                    .toggleStyle(.switch)
                            }
                            GridRow {
                                self.gridLabel("Session target")
                                Picker("", selection: self.$sessionTarget) {
                                    Text("main").tag(CronSessionTarget.main)
                                    Text("isolated").tag(CronSessionTarget.isolated)
                                }
                                .labelsHidden()
                                .pickerStyle(.segmented)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            GridRow {
                                self.gridLabel("Wake mode")
                                Picker("", selection: self.$wakeMode) {
                                    Text("next-heartbeat").tag(CronWakeMode.nextHeartbeat)
                                    Text("now").tag(CronWakeMode.now)
                                }
                                .labelsHidden()
                                .pickerStyle(.segmented)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            GridRow {
                                Color.clear
                                    .frame(width: self.labelColumnWidth, height: 1)
                                Text(
                                    Self.sessionTargetNote)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }

                    GroupBox("Schedule") {
                        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                            GridRow {
                                self.gridLabel("Kind")
                                Picker("", selection: self.$scheduleKind) {
                                    Text("at").tag(ScheduleKind.at)
                                    Text("every").tag(ScheduleKind.every)
                                    Text("cron").tag(ScheduleKind.cron)
                                }
                                .labelsHidden()
                                .pickerStyle(.segmented)
                                .frame(maxWidth: .infinity)
                            }
                            GridRow {
                                Color.clear
                                    .frame(width: self.labelColumnWidth, height: 1)
                                Text(
                                    Self.scheduleKindNote)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }

                            switch self.scheduleKind {
                            case .at:
                                GridRow {
                                    self.gridLabel("At")
                                    DatePicker(
                                        "",
                                        selection: self.$atDate,
                                        displayedComponents: [.date, .hourAndMinute])
                                        .labelsHidden()
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                GridRow {
                                    self.gridLabel("Auto-delete")
                                    Toggle("Delete after successful run", isOn: self.$deleteAfterRun)
                                        .toggleStyle(.switch)
                                }
                            case .every:
                                GridRow {
                                    self.gridLabel("Every")
                                    TextField("10m, 1h, 1d", text: self.$everyText)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(maxWidth: .infinity)
                                }
                            case .cron:
                                GridRow {
                                    self.gridLabel("Expression")
                                    TextField("e.g. 0 9 * * 3", text: self.$cronExpr)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(maxWidth: .infinity)
                                }
                                GridRow {
                                    self.gridLabel("Timezone")
                                    TextField("Optional (e.g. America/Los_Angeles)", text: self.$cronTz)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(maxWidth: .infinity)
                                }
                            }
                        }
                    }

                    GroupBox("Payload") {
                        VStack(alignment: .leading, spacing: 10) {
                            if self.sessionTarget == .isolated {
                                Text(Self.isolatedPayloadNote)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                self.agentTurnEditor
                            } else {
                                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                                    GridRow {
                                        self.gridLabel("Kind")
                                        Picker("", selection: self.$payloadKind) {
                                            Text("systemEvent").tag(PayloadKind.systemEvent)
                                            Text("agentTurn").tag(PayloadKind.agentTurn)
                                        }
                                        .labelsHidden()
                                        .pickerStyle(.segmented)
                                        .frame(maxWidth: .infinity)
                                    }
                                    GridRow {
                                        Color.clear
                                            .frame(width: self.labelColumnWidth, height: 1)
                                        Text(
                                            Self.mainPayloadNote)
                                            .font(.footnote)
                                            .foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }

                                switch self.payloadKind {
                                case .systemEvent:
                                    TextField("System event text", text: self.$systemEventText, axis: .vertical)
                                        .textFieldStyle(.roundedBorder)
                                        .lineLimit(3...7)
                                        .frame(maxWidth: .infinity)
                                case .agentTurn:
                                    self.agentTurnEditor
                                }
                            }
                        }
                    }

                    if self.sessionTarget == .isolated {
                        GroupBox("Main session summary") {
                            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                                GridRow {
                                    self.gridLabel("Prefix")
                                    TextField("Cron", text: self.$postPrefix)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(maxWidth: .infinity)
                                }
                                GridRow {
                                    Color.clear
                                        .frame(width: self.labelColumnWidth, height: 1)
                                    Text(
                                        Self.mainSummaryNote)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 2)
            }

            if let error, !error.isEmpty {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Button("Cancel") { self.onCancel() }
                    .keyboardShortcut(.cancelAction)
                    .buttonStyle(.bordered)
                Spacer()
                Button {
                    self.save()
                } label: {
                    if self.isSaving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(self.isSaving)
            }
        }
        .padding(24)
        .frame(minWidth: 720, minHeight: 640)
        .onAppear { self.hydrateFromJob() }
        .onChange(of: self.payloadKind) { _, newValue in
            if newValue == .agentTurn, self.sessionTarget == .main {
                self.sessionTarget = .isolated
            }
        }
        .onChange(of: self.sessionTarget) { _, newValue in
            if newValue == .isolated {
                self.payloadKind = .agentTurn
            } else if newValue == .main, self.payloadKind == .agentTurn {
                self.payloadKind = .systemEvent
            }
        }
    }

    var agentTurnEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                GridRow {
                    self.gridLabel("Message")
                    TextField("What should clawd do?", text: self.$agentMessage, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(3...7)
                        .frame(maxWidth: .infinity)
                }
                GridRow {
                    self.gridLabel("Thinking")
                    TextField("Optional (e.g. low)", text: self.$thinking)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: .infinity)
                }
                GridRow {
                    self.gridLabel("Timeout")
                    TextField("Seconds (optional)", text: self.$timeoutSeconds)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 180, alignment: .leading)
                }
                GridRow {
                    self.gridLabel("Deliver")
                    Toggle("Deliver result to a channel", isOn: self.$deliver)
                        .toggleStyle(.switch)
                }
            }

            if self.deliver {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                    GridRow {
                        self.gridLabel("Channel")
                        Picker("", selection: self.$channel) {
                            ForEach(self.channelOptions, id: \.self) { channel in
                                Text(self.channelLabel(for: channel)).tag(channel)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    GridRow {
                        self.gridLabel("To")
                        TextField("Optional override (phone number / chat id / Discord channel)", text: self.$to)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: .infinity)
                    }
                    GridRow {
                        self.gridLabel("Best-effort")
                        Toggle("Do not fail the job if delivery fails", isOn: self.$bestEffortDeliver)
                            .toggleStyle(.switch)
                    }
                }
            }
        }
    }
}
