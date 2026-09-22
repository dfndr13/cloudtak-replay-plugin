# Core Integration

The Replay Plugin is mostly self-contained under `plugin/replay/` (see the
top-level README), but several pieces of it necessarily live in CloudTAK's
core codebase rather than the plugin folder — split across the stateful and
stateless processes introduced by CloudTAK's 13.45+ hub/api split.

This folder mirrors the target path inside a CloudTAK checkout — strip the
`core-integration/` prefix and that's exactly where each file goes.
`install.sh` at the repo root does this for you, including applying/reversing
the patches; this table is for understanding what it did (or for applying by
hand on a checkout that's diverged too far for `git apply` to manage).

## Files this plugin owns outright

| File here | Goes to (in a CloudTAK checkout) | What it is |
|---|---|---|
| `api/stateful/lib/replay-recorder.ts` | `api/stateful/lib/replay-recorder.ts` | New file. `Recorder` class: bootstraps the `replay_events`/`replay_cot` tables, records live CoT tapped from `ConnectionPool.cots()`, and handles direct-write capture/removal for drawn/authored features (including Mission-linked ones). Lives in the **stateful** process — it's instantiated on `ConnectionPool`. |
| `api/stateless/lib/replay-player.ts` | `api/stateless/lib/replay-player.ts` | New file. `Player` class: runs playback sessions, replaying recorded CoT to the requesting user's own browser session only, via `config.hub.submitCots({ write: false, broadcast: true, replay: true })`. Lives in the **stateless** process — it's driven entirely by HTTP routes, not a live stream, so it doesn't need to be co-located with `ConnectionPool`. |
| `api/stateless/routes/replay.ts` | `api/stateless/routes/replay.ts` | New file. All `/replay/*` HTTP routes: start/stop/status recording, direct-write capture routes, playback session control, export/import, delete. Recording-control routes 503 if `config.recorder` is undefined (standalone `api` mode — see top-level README's Requirements). |
| `api/stateless/lib/retention/replay.ts` | `api/stateless/lib/retention/replay.ts` | New file. A `RetentionTask` (auto-discovered by `Retention.init()`'s directory scan — no wiring needed) that deletes `replay_events` older than `retention::replay::days` (default 10); `replay_cot` cascades via its `ON DELETE CASCADE` FK. |
| `api/test/replay-retention.srv.test.ts` | `api/test/replay-retention.srv.test.ts` | New file. Integration test for the retention task above, using this repo's existing `Flight` test harness. Optional — only install it if this checkout runs its own test suite. |

## Files this plugin patches (additive-only)

| Patch here | Target (in a CloudTAK checkout) | What it adds |
|---|---|---|
| `api/stateful/lib/connection-pool.ts.patch` | `api/stateful/lib/connection-pool.ts` | Wires a `Recorder` instance onto `ConnectionPool` and taps its `cots()` method so live/shared CoT traffic gets recorded when active — skipping CoTs tagged `opts.replay` so a running playback never feeds itself back into a concurrently active recording. Also tags every outgoing feature's `properties.replay` (explicitly, even when `false`, so a stale flag can't survive onto a UID that's now genuinely live) so the frontend can tell replayed CoT apart from live. |
| `api/stateless/config.ts.patch` | `api/stateless/config.ts` | Adds an optional `recorder?: Recorder` field to `ConfigStateless`, carried in from the constructor/`.env()` opts — a direct reference to the co-located stateful process's `Recorder`, present only in combined `both` mode. |
| `api/index.ts.patch` | `api/index.ts` | One-line addition at the `ConfigStateless.env()` call site: passes `recorder: stateful.conns.recorder` through when a stateful process exists in this deployment. |
| `api/web/src/workers/atlas-database.ts.patch` | `api/web/src/workers/atlas-database.ts` | Adds `recordingActive` state (pushed from the main thread via Comlink, and re-checked once at Worker boot so a mid-recording page reload doesn't blind the capture) and direct-write hooks so drawn/authored features that never reach `ConnectionPool.cots()` — including Mission-linked ones, and deletions of them reported via TAK Server's Mission `REMOVE_CONTENT` change notification — still get captured. |

## Applying the patches

Prefer `./install.sh` at the repo root — it applies these idempotently
(skips a patch that's already applied) and can reverse them on `--remove`.
To apply by hand, from the root of a CloudTAK checkout:

```sh
git apply core-integration/api/stateful/lib/connection-pool.ts.patch
git apply core-integration/api/stateless/config.ts.patch
git apply core-integration/api/index.ts.patch
git apply core-integration/api/web/src/workers/atlas-database.ts.patch
```

All four patches are additive-only (no lines removed) against CloudTAK
13.69.0, verified to reconstruct the exact current file when applied. If one
fails to apply cleanly on a newer checkout, the surrounding code has likely
moved on since — diff the hunk context by hand and re-apply the same
additions using the table above as a guide to intent.
