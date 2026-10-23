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
| `api/test/replay-recorder.test.ts` | `api/test/replay-recorder.test.ts` | New file. Unit test for the recorder's duplicate check (`contentHash`). Optional, like the test above. |

## Files this plugin patches

| Patch here | Target (in a CloudTAK checkout) | What it adds |
|---|---|---|
| `api/common/hub/index.ts.patch` | `api/common/hub/index.ts` | Adds `replay?: boolean` to `SubmitCotsRequest`, so `hub.submitCots({ …, replay: true })` (used by the player) type-checks. |
| `api/stateful/lib/hub/local.ts.patch` | `api/stateful/lib/hub/local.ts` | Passes `{ replay: req.replay === true }` into `ConnectionPool.cots()` when broadcasting. Changes one existing line. |
| `api/stateful/routes/cots.ts.patch` | `api/stateful/routes/cots.ts` | Accepts and forwards `replay` on the stateful `/cots` route, so the flag also survives the RPC hop in a split hub/api deployment. |
| `api/common/defaults.ts.patch` | `api/common/defaults.ts` | Defaults for `retention::replay::enabled` (`false`, opt-in like the other retention tasks) and `retention::replay::days` (`10`). |
| `api/common/types.ts.patch` | `api/common/types.ts` | Schema entries for the two `retention::replay::*` settings. |
| `tasks/retention/src/index.ts.patch` | `tasks/retention/src/index.ts` | Asks the API for `retention::replay::enabled` along with the other retention switches. Changes one existing line. |
| `tasks/retention/src/tasks.ts.patch` | `tasks/retention/src/tasks.ts` | Registers the `replay` retention task (runs only when `retention::replay::enabled` is true). |
| `tasks/retention/test/tasks.test.ts.patch` | `tasks/retention/test/tasks.test.ts` | Updates the retention task list test to include `replay`. |
| `api/stateful/lib/connection-pool.ts.patch` | `api/stateful/lib/connection-pool.ts` | Wires a `Recorder` instance onto `ConnectionPool` and taps its `cots()` method so live/shared CoT traffic gets recorded when active — skipping CoTs tagged `opts.replay` so a running playback never feeds itself back into a concurrently active recording. Also tags every outgoing feature's `properties.replay` (explicitly, even when `false`, so a stale flag can't survive onto a UID that's now genuinely live) so the frontend can tell replayed CoT apart from live. |
| `api/stateless/config.ts.patch` | `api/stateless/config.ts` | Adds an optional `recorder?: Recorder` field to `ConfigStateless`, carried in from the constructor/`.env()` opts — a direct reference to the co-located stateful process's `Recorder`, present only in combined `both` mode. |
| `api/index.ts.patch` | `api/index.ts` | One-line addition at the `ConfigStateless.env()` call site: passes `recorder: stateful.conns.recorder` through when a stateful process exists in this deployment. |
| `app/src/workers/atlas-database.ts.patch` | `app/src/workers/atlas-database.ts` | Imports `std` and adds `recordingActive` state (pushed from the main thread via Comlink, and re-checked once at Worker boot so a mid-recording page reload doesn't blind the capture) and direct-write hooks so drawn/authored features that never reach `ConnectionPool.cots()` — including Mission-linked ones, and deletions of them reported via TAK Server's Mission `REMOVE_CONTENT` change notification — still get captured. |
| `api/test/fixtures/get_schema.json.patch` | `api/test/fixtures/get_schema.json` | Adds the 17 `/replay/*` routes to the API schema fixture, so CloudTAK's `api/schema` test passes with the plugin installed. Appended at the end of the file, which is identical in every supported release. |

## Applying the patches

Prefer `./install.sh` at the repo root — it checks every patch first, applies
them idempotently (skips a patch that's already applied) and can reverse them
on `--remove`. To apply by hand, from the root of a CloudTAK checkout (check
first, so a mismatch doesn't leave a half-applied tree):

```sh
P=/path/to/cloudtak-replay-plugin/core-integration
for f in $(cd "$P" && find . -name '*.patch' | sort); do git apply --check "$P/$f" || exit 1; done
for f in $(cd "$P" && find . -name '*.patch' | sort); do git apply "$P/$f"; done
```

The patches are generated against CloudTAK v13.113.0 and apply cleanly to
every release from v13.109.3 to v13.113.0. Most are additive; two
(`hub/local.ts`, `tasks/retention/src/index.ts`) and the `std` import in
`atlas-database.ts` change one existing line each. If one fails on a newer
checkout, the surrounding code has likely moved on — diff the hunk context by
hand and re-apply the same change, using the table above as a guide to intent.
