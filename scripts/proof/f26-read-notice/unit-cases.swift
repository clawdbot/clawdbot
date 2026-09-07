
extension ChatViewModelTests {
    private static var f26Notice: String {
        "Could not refresh models. Previous choices are unchanged. Refresh to retry."
    }

    @Test @MainActor func f26ThrownReadRetainsChoicesAndClearsOnlyItsNotice() async throws {
        let choice = modelChoice(id: "alpha", name: "alpha", provider: "f26", available: true)
        let (_, vm) = await makeViewModel(historyResponses: [historyPayload()], modelCatalogHook: { call in
            if call == 1 { throw NSError(domain: "Gateway", code: 5) }
            return OpenClawChatModelCatalogSnapshot(choices: [choice], availabilityIsSessionScoped: true)
        })
        await vm.fetchModels()
        vm.input = "Unsent F26 draft"
        let selected = vm.modelSelectionID
        await vm.fetchModels()
        #expect(vm.modelChoices == [choice])
        #expect(vm.modelSelectionID == selected)
        #expect(vm.input == "Unsent F26 draft")
        #expect(vm.errorText == Self.f26Notice)
        await vm.fetchModels()
        #expect(vm.errorText == nil)
        vm.errorText = "Unrelated action failed"
        await vm.fetchModels()
        #expect(vm.errorText == "Unrelated action failed")
    }

    @Test @MainActor func f26CancellationAndUnrelatedErrorKeepTheirOwners() async {
        let (_, cancelled) = await makeViewModel(historyResponses: [historyPayload()], modelCatalogHook: { _ in throw CancellationError() })
        await cancelled.fetchModels()
        #expect(cancelled.errorText == nil)
        let (_, failed) = await makeViewModel(historyResponses: [historyPayload()], modelCatalogHook: { _ in throw NSError(domain: "Gateway", code: 5) })
        failed.errorText = "Model patch failed"
        await failed.fetchModels()
        #expect(failed.errorText == "Model patch failed")
    }

    @Test @MainActor func f26StaleFailureCannotReplaceNewerReadOutcome() async throws {
        let gate = AsyncGate()
        let choice = modelChoice(id: "alpha", name: "alpha", provider: "f26", available: true)
        let (transport, vm) = await makeViewModel(historyResponses: [historyPayload()], modelCatalogHook: { call in
            if call == 0 {
                await gate.wait()
                throw NSError(domain: "Gateway", code: 5)
            }
            return OpenClawChatModelCatalogSnapshot(choices: [choice], availabilityIsSessionScoped: true)
        })
        let old = Task { await vm.fetchModels() }
        do {
            try await waitUntil("old read starts") { await transport.modelAgentIDs().count == 1 }
        } catch {
            await gate.open()
            await old.value
            throw error
        }
        await vm.fetchModels()
        await gate.open()
        await old.value
        #expect(vm.modelChoices == [choice])
        #expect(vm.errorText == nil)
    }

    @Test @MainActor func f26BootstrapFailureNoticeSurvivesCompletion() async throws {
        let (_, vm) = await makeViewModel(
            historyResponses: [historyPayload()],
            modelCatalogHook: { _ in throw NSError(domain: "Gateway", code: 5) })
        try await loadAndWaitBootstrap(vm: vm)
        try await waitUntil("bootstrap loading completes") {
            await MainActor.run { !vm.isLoading }
        }
        #expect(vm.errorText == Self.f26Notice)
        #expect(!vm.isLoading)
    }

    @Test @MainActor func f26ReadCannotMaskAnInFlightSettingsFailure() async throws {
        let readGate = AsyncGate()
        let patchGate = AsyncGate()
        let alpha = modelChoice(id: "alpha", name: "alpha", provider: "f26", available: true)
        let beta = modelChoice(id: "beta", name: "beta", provider: "f26", available: true)
        let (transport, vm) = await makeViewModel(
            historyResponses: [historyPayload()],
            modelCatalogHook: { call in
                if call > 0 {
                    await readGate.wait()
                    throw NSError(domain: "Gateway", code: 5)
                }
                return OpenClawChatModelCatalogSnapshot(choices: [alpha, beta], availabilityIsSessionScoped: true)
            },
            setSessionModelHook: { _ in
                await patchGate.wait()
                throw NSError(domain: "F26Patch", code: 1, userInfo: [NSLocalizedDescriptionKey: "F26 model patch failed"])
            })
        await vm.fetchModels()
        let oldRead = Task { await vm.fetchModels() }
        do {
            try await waitUntil("read starts before selection") { await transport.modelAgentIDs().count == 2 }
            vm.selectModel(beta.selectionID)
            #expect(vm.isUpdatingSessionSettings)
            await readGate.open()
            await oldRead.value
            #expect(vm.modelSelectionID == beta.selectionID)
            #expect(vm.errorText == nil)
            #expect(vm.isUpdatingSessionSettings)
            await patchGate.open()
            try await waitUntil("settings failure owns the notice") {
                await MainActor.run { !vm.isUpdatingSessionSettings }
            }
            #expect(vm.errorText == "F26 model patch failed")
        } catch {
            await readGate.open()
            await patchGate.open()
            await oldRead.value
            throw error
        }
    }
}
