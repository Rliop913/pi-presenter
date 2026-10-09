# Observing long Presenter calls

`/presenter` and the native `/pdje-m3-test` harness keep a status/widget visible while work runs. The widget shows the actual checkpoint state and phase, internal role, compact unit (if used), call index, attempt, elapsed time, allocated timeout/remaining limit, and last failure. It remains visible with the final outcome. Heartbeats do not add transcript notifications, model calls, progress percentages, or estimated completion times.

The native harness and `testpresentation/run-approved.ts` additionally atomically update:

`testpresentation/.presentation/live-test/progress.json`

This is the authoritative monitoring snapshot, separate from approval/configuration, the audited call trace and legacy `result.json`/`ui-state.json`. It is not an approval or completion gate. Status is `start`, `running`, `error`, `complete`, or `cancelled`; `state` comes directly from the Store checkpoint. Startup, native approval, source collection, and dependency verification have explicit phases. During the pipeline the phase follows the real checkpoint state. A model call is current only after its live start event, never because a historical trace entry says `started`.

Periodic model-call heartbeats and checkpoint/UI/file refreshes each use a 3-second cadence; lifecycle and phase transitions update immediately. Direct execution prints compact summaries plus existing start/success/error records. `remainingMs` is remaining allocated call time, **not an ETA**. Attempt 2 or 3 means an actual retry; historical failure text remains visible during recovery.

## Liveness and finalization

Live snapshots include PID, timestamps, and `heartbeatAt`. **Do not treat the stored `running` label alone as evidence that work is still running.** Missing heartbeats, heartbeats older than 12 seconds, or a known-dead PID mean stopped/unknown (`progressLiveness` implements this check). A killed process cannot write a final status; stale files must not be presented as live. PID reuse is possible, so heartbeat freshness is necessary even when a PID exists.

Final snapshots remove the heartbeat and current call. Harness completion is recorded only after the actual pipeline/export completes; normal Presenter commands record their own operation outcome separately from the checkpoint `state`. Cancellation and errors stop all monitoring timers, remove owned signal listeners, and drain serialized writes before releasing the operation lock. Progress writes have at most one in-flight and one coalesced pending snapshot, so an older running write cannot race the terminal snapshot. Monitoring timers are unreferenced; model-call timeout timers retain their existing execution semantics.

Monitor I/O/UI failures are isolated and reported as `monitorError`/“Monitor unavailable” where possible; they never authorize execution or weaken validation. If storage fails, no durable monitoring guarantee is possible. A competing operation that cannot acquire the lock does not overwrite the owner's snapshot.

## Offline checks

- `npx tsx --test tests/progress.test.ts testpresentation/progress.test.ts`
- `npm run typecheck`
- `npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --types node testpresentation/live-test.ts testpresentation/run-approved.ts testpresentation/progress.test.ts`

These use temporary workspaces, controlled timers, mock registries, and forced failures. They do not certify live M3 output, native terminal rendering, or real end-to-end presentation production.
