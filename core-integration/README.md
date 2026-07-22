# Core Integration

The Replay Plugin is mostly self-contained under `plugin/replay/` (see the
top-level README), but a few pieces of it necessarily live in CloudTAK's
core codebase rather than the plugin folder:

- Two brand-new files that the plugin owns entirely, just not placed under
  `api/web/plugins/`.
- Two small, additive edits to existing core files that CloudTAK owns,
  needed to wire the plugin in.

This folder mirrors the target path inside a CloudTAK checkout — strip the
`core-integration/` prefix and that's exactly where each file goes:

| File here | Goes to (in a CloudTAK checkout) | What it is |
|---|---|---|
| `api/lib/replay-recorder.ts` | `api/lib/replay-recorder.ts` | New file. `Recorder` class: bootstraps the `replay_events`/`replay_cot` tables, records live CoT tapped from `ConnectionPool.cots()`, and handles direct-write capture/removal for drawn features. |
| `api/routes/replay.ts` | `api/routes/replay.ts` | New file. All `/replay/*` HTTP routes: start/stop/status recording, direct-write capture routes, playback session control, export/import, delete. |
| `api/lib/connection-pool.ts.patch` | Patch against `api/lib/connection-pool.ts` | Existing core file. Wires a `Recorder` instance onto `ConnectionPool` and taps its `cots()` method so live/shared CoT traffic gets recorded when active. Also tags outgoing features with `properties.replay` so the frontend can tell replayed CoT apart from live. |
| `api/web/src/workers/atlas-database.ts.patch` | Patch against `api/web/src/workers/atlas-database.ts` | Existing core file (Web Worker). Adds `recordingActive` state (pushed from the main thread via Comlink) and direct-write hooks so drawn/authored features that never reach `ConnectionPool.cots()` still get captured, plus a removal hook on delete. |

`replay-player.ts` (playback) has no core dependency of its own — it's
included here alongside the other new files for completeness:

| File here | Goes to | What it is |
|---|---|---|
| `api/lib/replay-player.ts` | `api/lib/replay-player.ts` | New file. `Player` class: runs playback sessions, replaying recorded CoT back to the requesting user's own browser session only. |

## Applying the patches

From the root of a CloudTAK checkout:

```sh
git apply core-integration/api/lib/connection-pool.ts.patch
git apply core-integration/api/web/src/workers/atlas-database.ts.patch
```

Both patches are additive-only (no lines removed) against CloudTAK as of
commit `a1a1591c7`. If they fail to apply cleanly on a newer checkout, the
surrounding code has likely moved on since — diff the hunk context by hand
and re-apply the same additions.
