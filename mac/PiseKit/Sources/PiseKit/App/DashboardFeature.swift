import ComposableArchitecture
import Foundation

@Reducer
struct DashboardFeature {
    enum Tab: String, CaseIterable {
        case overview = "Overview", breakdown = "Breakdown", skills = "Skills"
    }

    @ObservableState
    struct State: Equatable {
        var query = ReportQuery()
        var report = DashboardReport()
        var tab: Tab = .overview
        var loading = false
        var failure: String?
        var visible = false
        var generation = 0
        var needsReload = true
        var previewOnly = false
    }

    enum Action: BindableAction, Equatable {
        case binding(BindingAction<State>)
        case visibilityChanged(Bool)
        case refreshTapped
        case quitTapped
        case clearFiltersTapped
        case projectSelected(String?)
        case modelSelected(String)
        case fileChanged
        case debounceElapsed
        case minuteTick
        case reportReceived(generation: Int, Result<DashboardReport, ReportFailure>)
    }

    struct ReportFailure: Error, Equatable, Sendable {
        var message: String
    }

    @Dependency(\.ledgerClient) var ledger
    @Dependency(\.applicationClient) var application
    @Dependency(\.continuousClock) var clock

    private enum CancelID { case report, watcher, minuteTick, debounce }

    var body: some ReducerOf<Self> {
        BindingReducer()
        Reduce { state, action in
            switch action {
            case .binding(\.tab):
                return .none

            case .binding:
                return refresh(&state, reload: false)

            case let .visibilityChanged(visible):
                guard !state.previewOnly, state.visible != visible else { return .none }
                state.visible = visible
                if visible {
                    return .merge(
                        refresh(&state, reload: true),
                        .run { [ledger] send in
                            let changes = await ledger.changes()
                            for await _ in changes {
                                await send(.fileChanged)
                            }
                        }.cancellable(id: CancelID.watcher, cancelInFlight: true),
                        .run { [clock] send in
                            for await _ in clock.timer(interval: .seconds(60)) {
                                await send(.minuteTick)
                            }
                        }.cancellable(id: CancelID.minuteTick, cancelInFlight: true)
                    )
                }
                return stop(&state)

            case .refreshTapped:
                return refresh(&state, reload: true)

            case .quitTapped:
                guard !state.previewOnly else { return .none }
                return .concatenate(
                    stop(&state),
                    .run { [application] _ in await application.quit() }
                )

            case .clearFiltersTapped:
                state.query.project = nil
                state.query.model = nil
                state.query.branch = nil
                state.query.tag = nil
                return refresh(&state, reload: false)

            case let .projectSelected(project):
                state.query.project = project
                state.query.model = nil
                state.query.branch = nil
                state.query.tag = nil
                return refresh(&state, reload: false)

            case let .modelSelected(model):
                state.query.model = model
                state.tab = .breakdown
                return refresh(&state, reload: false)

            case .fileChanged:
                guard state.visible, !state.previewOnly else { return .none }
                state.needsReload = true
                return .run { [clock] send in
                    try await clock.sleep(for: .milliseconds(300))
                    await send(.debounceElapsed)
                }.cancellable(id: CancelID.debounce, cancelInFlight: true)

            case .debounceElapsed:
                return refresh(&state, reload: true)

            case .minuteTick:
                return refresh(&state, reload: false)

            case let .reportReceived(generation, result):
                guard state.visible, generation == state.generation else { return .none }
                state.loading = false
                switch result {
                case let .success(report):
                    state.report = report
                    state.needsReload = false
                case let .failure(error):
                    state.failure = error.message
                }
                return .none
            }
        }
    }

    private func stop(_ state: inout State) -> Effect<Action> {
        state.visible = false
        state.loading = false
        state.generation += 1
        return .merge(
            .cancel(id: CancelID.report),
            .cancel(id: CancelID.watcher),
            .cancel(id: CancelID.minuteTick),
            .cancel(id: CancelID.debounce)
        )
    }

    private func refresh(_ state: inout State, reload: Bool) -> Effect<Action> {
        guard state.visible, !state.previewOnly else { return .none }
        state.needsReload = state.needsReload || reload
        state.generation += 1
        state.loading = true
        state.failure = nil
        return .run { [ledger, query = state.query, reload = state.needsReload, generation = state.generation] send in
            do {
                let report = try await ledger.report(query, reload)
                try Task.checkCancellation()
                await send(.reportReceived(generation: generation, .success(report)))
            } catch is CancellationError {
                // A newer query or closing the popover owns the visible state.
            } catch {
                guard !Task.isCancelled else { return }
                await send(.reportReceived(generation: generation, .failure(ReportFailure(message: error.localizedDescription))))
            }
        }.cancellable(id: CancelID.report, cancelInFlight: true)
    }
}
