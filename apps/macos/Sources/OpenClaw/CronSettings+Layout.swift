import SwiftUI

extension CronSettings {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.header
            self.schedulerBanner
            self.content
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.leading, 18)
        .padding(.trailing, SettingsLayout.scrollbarGutter)
        .onAppear {
            self.updateActiveWork(active: self.isActive)
        }
        .onChange(of: self.isActive) { _, active in
            self.updateActiveWork(active: active)
        }
        .onDisappear {
            self.store.stop()
            self.channelsStore.stop()
        }
        .sheet(isPresented: self.$showEditor) {
            CronJobEditor(
                job: self.editingJob,
                isSaving: self.$isSaving,
                error: self.$editorError,
                channelsStore: self.channelsStore,
                onCancel: {
                    self.showEditor = false
                    self.editingJob = nil
                },
                onSave: { payload in
                    Task {
                        await self.save(payload: payload)
                    }
                })
        }
        .alert("Delete cron job?", isPresented: Binding(
            get: { self.confirmDelete != nil },
            set: { if !$0 { self.confirmDelete = nil } }))
        {
            Button("Cancel", role: .cancel) { self.confirmDelete = nil }
            Button("Delete", role: .destructive) {
                if let job = self.confirmDelete {
                    Task { await self.store.removeJob(id: job.id) }
                }
                self.confirmDelete = nil
            }
        } message: {
            if let job = self.confirmDelete {
                Text(job.displayName)
            }
        }
    }

    private func updateActiveWork(active: Bool) {
        if active {
            self.store.start()
            self.channelsStore.start()
        } else {
            self.store.stop()
            self.channelsStore.stop()
        }
    }

    var schedulerBanner: some View {
        Group {
            if self.store.schedulerEnabled == false {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text("Cron scheduler is disabled")
                            .font(.headline)
                        Spacer()
                    }
                    Text(
                        "Jobs are saved, but they will not run automatically until `cron.enabled` is set to `true` " +
                            "and the Gateway restarts.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let storePath = self.store.schedulerStorePath, !storePath.isEmpty {
                        Text(storePath)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color.orange.opacity(0.10))
                .cornerRadius(8)
            }
        }
    }

    var header: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Cron Jobs")
                    .font(.title3.weight(.semibold))
                Text("Manage Gateway cron jobs and inspect run history.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 16)

            HStack(spacing: 8) {
                Button {
                    Task { await self.store.refreshJobs() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(self.store.isLoadingJobs)

                Button {
                    self.editorError = nil
                    self.editingJob = nil
                    self.showEditor = true
                } label: {
                    Label("New Job", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    var content: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                if let err = self.store.lastError {
                    Text("Error: \(err)")
                        .font(.footnote)
                        .foregroundStyle(.red)
                } else if let msg = self.store.statusMessage {
                    Text(msg)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(self.store.jobs) { job in
                            Button {
                                self.selectJob(job.id)
                            } label: {
                                self.jobRow(job)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 8)
                                    .background(
                                        self.store.selectedJobId == job.id
                                            ? Color.accentColor.opacity(0.18) : .clear)
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .contextMenu { self.jobContextMenu(job) }
                        }

                        if self.store.jobs.isEmpty {
                            Text("No cron jobs yet.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 6)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .frame(width: 250)

            Divider()

            self.detail
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func selectJob(_ id: String) {
        self.store.selectedJobId = id
        Task { await self.store.refreshRuns(jobId: id) }
    }

    @ViewBuilder
    var detail: some View {
        if let selected = self.selectedJob {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 12) {
                    self.detailHeader(selected)
                    self.detailCard(selected)
                    self.runHistoryCard(selected)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 2)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("Select a job to inspect details and run history.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("Tip: use ‘New Job’ to add one, or enable cron in your gateway config.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.top, 8)
        }
    }
}
