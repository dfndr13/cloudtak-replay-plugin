# CloudTAK Replay Plugin

Records live and drawn CoT traffic under a named event, then plays it back
later — at any speed (set before starting playback), filtered by category —
for training and after-action review.

## What it does

- **Record** all CoT traffic flowing through this CloudTAK instance under a
  named event (e.g. "KSF 2026"), including features a user draws/authors
  locally — Mission-linked or not — even if they're never Shared/broadcast
  live. Starting a recording also snapshots every currently-live feature so
  pre-existing state has a baseline from the start of the window.
- **Play back** a recorded event on demand: pause/resume, jump back 30s,
  scrub by percentage, and toggle visibility by category (aircraft, UAS,
  ground, maritime, other). Speed (1x–50x) is set when starting playback.
- **Distinguish replay from live** while playback is running — the user's
  real live features are hidden for the duration of playback (so the map
  isn't a mix of "then" and "now"), while replayed features are tagged
  `properties.replay = true` and shown on top. The user's own self-position
  marker is exempted from this hiding, since its UID can coincide with a
  replayed copy of "themselves".
- **Export/import** a recorded event as a portable JSON file, so a
  recording made on one CloudTAK instance can be shared and replayed on
  another.

Playback is a private preview: it re-publishes recorded CoT only to the
requesting user's own browser session
(`config.hub.submitCots({ write: false, broadcast: true, replay: true })`),
never to TAK Server and never to other users. Nobody else sees a replay
unless they import the exported file into their own CloudTAK and play it
locally.

## Architecture

### Recording path — live/shared traffic

`api/stateful/lib/connection-pool.ts` wires a `Recorder` instance
(`api/stateful/lib/replay-recorder.ts`) onto `ConnectionPool`, tapping the
pool's existing `cots()` method:

```ts
if (this.recorder.active() && !opts.replay) await this.recorder.record(conn, cots);
```

The `!opts.replay` guard matters: without it, playing back an event while a
recording happens to be active would feed the replay's own rewritten-CoT
output straight back into the recording. Every CoT that already flows
through the pool (live gateway traffic, Mission-shared features) gets a row
in `replay_cot` while a recording is active, deduped by a content hash (so
unchanged repeats of the same UID don't spam the table).

### Recording path — drawn/authored features

A feature a user draws but never Shares (no active Mission) never reaches
`ConnectionPool.cots()`, so the tap above never sees it. The same is true of
a feature linked to a Mission but stored via `subscription_feature` — TAK
Server only rebroadcasts a "mission changed" notification over the
connection, never the feature's own CoT, so `Recorder.record()` never
captures its actual content either. To capture both cases, the Web Worker
that owns local feature state (`api/web/src/workers/atlas-database.ts`,
`AtlasDatabase`) direct-writes to the recording via two routes on
`api/stateless/routes/replay.ts`:

- `POST /replay/record/feature` — capture the feature's current GeoJSON
  state (called from `AtlasDatabase.add()`, both the plain and Mission
  branches, when `opts.authored` is set and a recording is active; also
  called once per feature by `snapshotForRecording()` right after a
  recording starts, to seed the baseline mentioned above).
- `DELETE /replay/record/feature/:id` — write a `kind = 'removed'` marker
  for that UID. Called from `AtlasDatabase.remove()` for this user's own
  deletes (both the plain-CONNECTION and Mission branches), and from
  `subChange()` for a TAK Server Mission `REMOVE_CONTENT` change
  notification — which fires for *any* Mission member's deletion of
  Mission-linked content, not just this user's own.

These bypass TAK Server and `connection-pool.ts` entirely — the feature is
captured into the active recording without ever being broadcast live.
`replay_cot.kind` distinguishes an ordinary snapshot (`'cot'`, the default)
from a `'removed'` marker; playback treats the most recent row per UID as
authoritative for "what does this feature look like at time T".

### Playback

`api/stateless/lib/replay-player.ts` (`Player`) runs one `PlaybackControl`
session per active playback, driven entirely by the routes in `replay.ts` —
it isn't hooked into any live stream, and doesn't need `ConnectionPool`
directly (it lives in the stateless process; recording does not). On each
tick it selects, per UID, the most recent `replay_cot` row at-or-before the
session's virtual clock:

- A `kind = 'removed'` row becomes a `ForceDelete` task for that UID — never
  handed to `CoTParser.from_xml()`, which would throw on its empty
  `cot_xml`.
- Otherwise it rewrites `time`/`start`/`stale` to the current wall clock
  (preserving the original stale offset), *unless* the row's own recorded
  stale window had already elapsed as of the session's virtual clock — a
  feed that just stopped sending updates mid-recording, with no explicit
  removal marker, stays gone instead of getting a fresh future `stale` time
  on every tick.

A seek/jump does a full resync (`DISTINCT ON (uid) ... ORDER BY recorded_at
DESC`); a normal tick only publishes what's newly crossed since the last
tick, so one-time side effects (e.g. a fileshare/data-package announcement)
fire once instead of repeating every second for the rest of playback. Any
per-row parse failure, or a `publishStateAt`/tick failure in general, is
caught and logged rather than thrown — one bad row can no longer take down
an entire session, let alone the whole API process. A session with no
status poll (the client's only recurring liveness signal) for 30 seconds is
reaped, so a closed tab/crash/network loss doesn't tick forever.

### Web Worker recording-active state

`AtlasDatabase` runs in its own Web Worker realm and can't read a
main-thread Vue reactive singleton directly — a Worker gets its own
instance per realm, and mutations don't cross the boundary. `ReplayPanel.vue`
pushes recording state across explicitly via a Comlink RPC,
`mapStore.worker.db.setRecordingActive(active)`, every time
`refreshRecordingStatus()` runs (on mount, and after start/stop). The
worker also checks `/api/replay/record/status` once at boot
(`AtlasDatabase.init()`), since a page reload gets a fresh worker instance
that defaults to `recordingActive = false` regardless of what's actually
running server-side — without that boot check, a mid-recording reload
would blind the direct-write capture until the user next visits the Replay
panel.

Two small shared-state pieces support the map banners:
`replay-state.ts` holds two reactive singletons (`replayPlaybackState`,
`recordingState`) that `ReplayBanner.vue` and `RecordingBanner.vue` render
from — both banners are mounted into `mapStore.bottomBar`, detached from
`ReplayPanel.vue`'s own component tree, so they need this shared state
rather than props.

### Retention

`api/stateless/lib/retention/replay.ts` registers a `replay` retention task
(auto-discovered — no core wiring needed) that deletes `replay_events`
older than `retention::replay::days` (default 10 days); `replay_cot` rows
cascade via their `ON DELETE CASCADE` foreign key. Exported events aren't
exempt — export is the mechanism for keeping data past the retention
window.

## Using it

**Start a recording**
1. Open the Replay panel, type an event name (e.g. "KSF 2026"), click
   **Record**. A red "RECORDING: \<name\>" banner appears at the bottom of
   the map for as long as it's active — recording continues server-side
   even if you close the panel or navigate away.
2. Draw/share features as normal. Anything Shared to a Mission or sent as
   live traffic is captured via the `connection-pool.ts` tap; anything
   drawn but not Shared (or linked to a Mission) is captured via the
   direct-write route.

**Stop a recording**
- Reopen the Replay panel and click **Stop**. The event is now listed under
  "Recorded events" and available for playback/export.

**Play one back**
1. Pick the event from the dropdown, set a speed, click **Start Playback**.
   Your own live features are hidden for the duration (except your
   self-marker) and a red "REPLAY: \<name\>" banner appears.
2. Use Pause/Play, the back button (rewinds 30 real seconds, scaled by
   speed), the scrubber, and the category checkboxes to control what plays.
   Speed can't be changed mid-playback — stop and restart to change it.
3. Click **Stop** (or let it run to the end) to restore your live features
   and remove the banner.

**Delete a recorded event**
- Select it in the dropdown and click **Delete**, then confirm. This is
  permanent — it removes the `replay_events` row and cascades to delete all
  of its `replay_cot` rows.

## Known issues

- **Export/import loses deletion markers.** The export route's `SELECT` and
  the `ReplayCotExportRow` shape don't include `kind`, and the import
  route's `INSERT` doesn't set it either (it defaults to `'cot'`). Playback
  now correctly turns a `kind = 'removed'` row into a disappearance — but an
  exported-then-reimported recording has already lost every such row, so an
  imported replay can't show a feature disappearing even when the original
  recording could.
- **The UAS category checkbox does nothing.** `categorize()` accepts a `how`
  parameter to distinguish a UAS (`how = 'm-u'`) from a piloted aircraft, but
  every call site passes `undefined` — `how` isn't stored as its own column
  (or otherwise recovered from the stored `cot_xml`), so every `a-*-A-*`
  track files as `aircraft` regardless of the checkbox.
- **No per-recording/per-session ownership check.** Every route
  authenticates the caller but doesn't check that they own the resource:
  any logged-in user can stop another user's active recording or delete any
  recorded event.
- **Recording doesn't resume automatically after an API restart.**
  `Recorder.activeEvent` is only reloaded from the DB by
  `Recorder.refresh()`, which is only called from the `GET
  /replay/record/status` route — not at process boot. A restart mid-recording
  records nothing until a user happens to open the Replay panel again.
- **Recording is on the live CoT hot path.** `ConnectionPool.cots()` awaits
  `recorder.record()` (hash + XML serialize + insert, per CoT) before
  continuing with live delivery. Under high-volume traffic (e.g. ADS-B) this
  adds latency to every user's live feed while a recording is active.
- **Toggling a category off mid-playback only stops new features of that
  category from being published** — it doesn't retroactively hide features
  of that category already drawn on the map.
- **Deletions by other Mission members are now captured for Mission-linked
  content** (via TAK Server's `REMOVE_CONTENT` change notification — see
  Architecture above), but this does *not* cover plain live/gateway CoT
  outside a Mission: real CoT delete tasking (`t-x-d-d`) for that traffic is
  not reliably delivered end-to-end, per TAK Product Center guidance. In
  that case the feature is simply never seen again in the live stream —
  recording has no signal that it was deleted rather than just quiet — so on
  playback it stays at its last known position/state and goes stale
  naturally (per its own `stale` timestamp) instead of disappearing at the
  moment it was actually deleted.

Upstream CloudTAK PR [#1598](https://github.com/dfpc-coe/CloudTAK/pull/1598)
adds broader `t-x-d-d` support to CloudTAK core. It's related to the last
gap above but this plugin doesn't rely on it or assume its behavior — worth
revisiting once/if it lands, but not a dependency today.
