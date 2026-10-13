import ComposableArchitecture
import Foundation
import Testing
@testable import PiseKit

@MainActor
struct DashboardFeatureTests {
    @Test func filtersAreReducerOwnedAndDoNotReadWhileHidden() async {
        var query = ReportQuery(range: .week, metric: .tokens, project: "old", model: "old-model", branch: "old-branch", tag: "old-tag")
        let store = TestStore(initialState: DashboardFeature.State(query: query)) { DashboardFeature() }
        await store.send(.projectSelected("new")) {
            $0.query.project = "new"
            $0.query.model = nil
            $0.query.branch = nil
            $0.query.tag = nil
        }
        await store.send(.clearFiltersTapped) { $0.query.project = nil }
        await store.send(.binding(.set(\.query.range, .month))) { $0.query.range = .month }
        await store.send(.binding(.set(\.tab, .skills))) { $0.tab = .skills }
        await store.send(.modelSelected("provider/model")) {
            $0.query.model = "provider/model"
            $0.tab = .breakdown
        }
        await store.send(.refreshTapped)
        await store.send(.fileChanged)
        await store.send(.minuteTick)
        query = store.state.query
        #expect(query.metric == .tokens)
        await store.finish()
    }

    @Test func openRefreshTickAndReopenChooseCorrectReadPolicy() async throws {
        let clock = TestClock()
        let requests = Requests()
        let report = try fixtureReport()
        let store = TestStore(initialState: DashboardFeature.State()) { DashboardFeature() } withDependencies: {
            $0.continuousClock = clock
            $0.ledgerClient = LedgerClient(
                report: { query, reload in
                    await requests.append(query: query, reload: reload)
                    var value = report
                    value.query = query
                    return value
                }, changes: { AsyncStream { $0.finish() } }
            )
        }
        await store.send(.visibilityChanged(true)) {
            $0.visible = true; $0.loading = true; $0.generation = 1
        }
        await store.receive(.reportReceived(generation: 1, .success(report))) {
            $0.report = report; $0.loading = false; $0.needsReload = false
        }
        await store.send(.visibilityChanged(true))
        await store.send(.binding(.set(\.query.metric, .tokens))) {
            $0.query.metric = .tokens; $0.loading = true; $0.generation = 2
        }
        var tokens = report
        tokens.query.metric = .tokens
        await store.receive(.reportReceived(generation: 2, .success(tokens))) {
            $0.report = tokens; $0.loading = false
        }
        await store.send(.binding(.set(\.tab, .skills))) { $0.tab = .skills }
        await clock.advance(by: .seconds(60))
        await store.receive(.minuteTick) { $0.loading = true; $0.generation = 3 }
        await store.receive(.reportReceived(generation: 3, .success(tokens))) { $0.loading = false }
        await store.send(.refreshTapped) {
            $0.loading = true; $0.needsReload = true; $0.generation = 4
        }
        await store.receive(.reportReceived(generation: 4, .success(tokens))) {
            $0.loading = false; $0.needsReload = false
        }
        await store.send(.visibilityChanged(false)) { $0.visible = false; $0.generation = 5 }
        await store.send(.visibilityChanged(false))
        await clock.advance(by: .seconds(120))
        await store.send(.visibilityChanged(true)) {
            $0.visible = true; $0.loading = true; $0.needsReload = true; $0.generation = 6
        }
        await store.receive(.reportReceived(generation: 6, .success(tokens))) {
            $0.loading = false; $0.needsReload = false
        }
        await store.send(.visibilityChanged(false)) { $0.visible = false; $0.generation = 7 }
        await store.finish()
        #expect(await requests.values.map(\.reload) == [true, false, false, true, true])
    }

    @Test func fileEventsDebounceFromTheLastEvent() async throws {
        let clock = TestClock()
        let requests = Requests()
        let report = try fixtureReport()
        let store = TestStore(initialState: DashboardFeature.State()) { DashboardFeature() } withDependencies: {
            $0.continuousClock = clock
            $0.ledgerClient = LedgerClient(
                report: { query, reload in
                    await requests.append(query: query, reload: reload)
                    return report
                }, changes: { AsyncStream { $0.finish() } }
            )
        }
        await store.send(.visibilityChanged(true)) {
            $0.visible = true; $0.loading = true; $0.generation = 1
        }
        await store.receive(.reportReceived(generation: 1, .success(report))) {
            $0.report = report; $0.loading = false; $0.needsReload = false
        }
        await store.send(.fileChanged) { $0.needsReload = true }
        await clock.advance(by: .milliseconds(299))
        #expect(await requests.values.count == 1)
        await store.send(.fileChanged)
        await clock.advance(by: .milliseconds(299))
        #expect(await requests.values.count == 1)
        await clock.advance(by: .milliseconds(1))
        await store.receive(.debounceElapsed) { $0.loading = true; $0.generation = 2 }
        await store.receive(.reportReceived(generation: 2, .success(report))) {
            $0.loading = false; $0.needsReload = false
        }
        await store.send(.visibilityChanged(false)) { $0.visible = false; $0.generation = 3 }
        await store.finish()
        #expect(await requests.values.map(\.reload) == [true, true])
    }

    @Test func closingCancelsSubscriptionPendingDebounceAndTimer() async throws {
        let clock = TestClock()
        let events = AsyncStream.makeStream(of: Void.self)
        let stopped = AsyncStream.makeStream(of: Bool.self)
        events.continuation.onTermination = { _ in
            stopped.continuation.yield(true)
            stopped.continuation.finish()
        }
        let report = try fixtureReport()
        let store = TestStore(initialState: DashboardFeature.State()) { DashboardFeature() } withDependencies: {
            $0.continuousClock = clock
            $0.ledgerClient = LedgerClient(report: { _, _ in report }, changes: { events.stream })
        }
        await store.send(.visibilityChanged(true)) {
            $0.visible = true; $0.loading = true; $0.generation = 1
        }
        await store.receive(.reportReceived(generation: 1, .success(report))) {
            $0.report = report; $0.loading = false; $0.needsReload = false
        }
        events.continuation.yield(())
        await store.receive(.fileChanged) { $0.needsReload = true }
        await store.send(.visibilityChanged(false)) { $0.visible = false; $0.generation = 2 }
        await store.finish()
        var iterator = stopped.stream.makeAsyncIterator()
        #expect(await iterator.next() == true)
        await clock.advance(by: .seconds(120))
        await store.send(.fileChanged)
        await store.send(.debounceElapsed)
        await store.send(.minuteTick)
        await store.finish()
    }

    @Test func cancelledRequestCannotOverwriteANewerQuery() async throws {
        let clock = TestClock()
        let report = try fixtureReport()
        let store = TestStore(initialState: DashboardFeature.State(visible: true, needsReload: false)) {
            DashboardFeature()
        } withDependencies: {
            $0.continuousClock = clock
            $0.ledgerClient.report = { query, _ in
                // Deliberately return even after cancellation. The feature must
                // prevent this stale result from becoming a received action.
                try? await clock.sleep(for: .seconds(10))
                var value = report
                value.query = query
                return value
            }
        }
        await store.send(.refreshTapped) { $0.loading = true; $0.needsReload = true; $0.generation = 1 }
        await store.send(.binding(.set(\.query.metric, .tokens))) {
            $0.query.metric = .tokens; $0.generation = 2
        }
        await clock.advance(by: .seconds(10))
        var tokens = report
        tokens.query.metric = .tokens
        await store.receive(.reportReceived(generation: 2, .success(tokens))) {
            $0.report = tokens; $0.loading = false; $0.needsReload = false
        }
        await store.send(.reportReceived(generation: 1, .success(report)))
        await store.send(.visibilityChanged(false)) { $0.visible = false; $0.generation = 3 }
        await store.finish()
    }

    @Test func closingCancelsAnInFlightReadAndIgnoresLateResponses() async throws {
        let clock = TestClock()
        let report = try fixtureReport()
        let store = TestStore(initialState: DashboardFeature.State(visible: true)) { DashboardFeature() } withDependencies: {
            $0.continuousClock = clock
            $0.ledgerClient.report = { _, _ in
                try? await clock.sleep(for: .seconds(10))
                return report
            }
        }
        await store.send(.refreshTapped) { $0.loading = true; $0.generation = 1 }
        await store.send(.visibilityChanged(false)) {
            $0.visible = false; $0.loading = false; $0.generation = 2
        }
        await store.finish()
        await clock.advance(by: .seconds(10))
        await store.send(.reportReceived(generation: 1, .success(report)))
        await store.finish()
    }

    @Test func failuresRetainPriorReportAndRefreshRetries() async throws {
        let requests = Requests()
        let report = try fixtureReport()
        let store = TestStore(initialState: DashboardFeature.State(report: report, visible: true, needsReload: false)) {
            DashboardFeature()
        } withDependencies: {
            $0.ledgerClient.report = { query, reload in
                if await requests.append(query: query, reload: reload) == 1 { throw ReadFailure() }
                return report
            }
        }
        await store.send(.refreshTapped) { $0.loading = true; $0.needsReload = true; $0.generation = 1 }
        await store.receive(.reportReceived(generation: 1, .failure(.init(message: "Synthetic read failure")))) {
            $0.loading = false; $0.failure = "Synthetic read failure"
        }
        await store.send(.refreshTapped) { $0.loading = true; $0.failure = nil; $0.generation = 2 }
        await store.receive(.reportReceived(generation: 2, .success(report))) {
            $0.loading = false; $0.needsReload = false
        }
        await store.send(.visibilityChanged(false)) { $0.visible = false; $0.generation = 3 }
        await store.finish()
    }

    @Test func quitUsesAnInjectedApplicationDependency() async {
        let quit = AsyncStream.makeStream(of: Bool.self)
        let store = TestStore(initialState: DashboardFeature.State(loading: true, visible: true)) {
            DashboardFeature()
        } withDependencies: {
            $0.applicationClient.quit = {
                quit.continuation.yield(true)
                quit.continuation.finish()
            }
        }
        await store.send(.quitTapped) {
            $0.visible = false; $0.loading = false; $0.generation = 1
        }
        await store.finish()
        var iterator = quit.stream.makeAsyncIterator()
        #expect(await iterator.next() == true)
    }

    @Test func previewsNeverStartLiveEffects() async throws {
        let report = try fixtureReport()
        let store = TestStore(initialState: DashboardFeature.State(query: report.query, report: report, previewOnly: true)) {
            DashboardFeature()
        }
        await store.send(.visibilityChanged(true))
        await store.send(.refreshTapped)
        await store.send(.quitTapped)
        await store.send(.fileChanged)
        await store.send(.minuteTick)
        await store.send(.binding(.set(\.query.metric, .tokens))) { $0.query.metric = .tokens }
        await store.finish()
    }

    private func fixtureReport() throws -> DashboardReport {
        try Reports.build(LedgerFixtures.snapshot(usage: [LedgerFixtures.usage()]), query: ReportQuery(),
                          now: LedgerFixtures.now, calendar: LedgerFixtures.calendar)
    }
}

private actor Requests {
    struct Request: Sendable { var query: ReportQuery; var reload: Bool }
    private(set) var values: [Request] = []
    @discardableResult func append(query: ReportQuery, reload: Bool) -> Int {
        values.append(Request(query: query, reload: reload))
        return values.count
    }
}

private struct ReadFailure: LocalizedError {
    var errorDescription: String? { "Synthetic read failure" }
}
