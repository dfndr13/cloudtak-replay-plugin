# CloudTAK Replay Plugin

Records live and drawn CoT traffic under a named event, then plays it back
later — at any speed, filtered by category — for training and after-action
review.

## What it does

- **Record** all CoT traffic flowing through this CloudTAK instance under a
  named event (e.g. "KSF 2026"), including features a user draws/authors
  locally even if they're never Shared to a Mission or broadcast live.
- **Play back** a recorded event on demand: pause/resume, jump back 30s,
  scrub by percentage, change speed (1x–50x), and toggle visibility by
  category (aircraft, UAS, ground, maritime, other).
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
requesting user's own browser session (`config.conns.cots()`), never to TAK
Server and never to other users. Nobody else sees a replay unless they
import the exported file into their own CloudTAK and play it locally.

## Architecture

### Recording path — live/shared traffic

`api/lib/connection-pool.ts` wires a `Recorder` instance
(`api/lib/replay-recorder.ts`) onto `ConnectionPool`, tapping the pool's
existing `cots()` method:

```ts
if (this.recorder.active()) await this.recorder.record(conn, cots);
```

This is the one core-CloudTAK file this plugin edits — everything else
lives under `api/web/plugins/replay/` and `api/routes/replay.ts`. Every CoT
that already flows through the pool (live gateway traffic, Mission-shared
features) gets a row in `replay_cot` while a recording is active, deduped
by a content hash (so unchanged repeats of the same UID don't spam the
table).

### Recording path — drawn/authored features

A feature a user draws but never Shares (no active Mission) never reaches
`ConnectionPool.cots()`, so the tap above never sees it. To capture these,
the Web Worker that owns local feature state
(`api/web/src/workers/atlas-database.ts`, `AtlasDatabase`) direct-writes to
the recording via two routes on `api/routes/replay.ts`:

- `POST /replay/record/feature` — capture the feature's current GeoJSON
  state (called from `AtlasDatabase.add()` when `opts.authored` is set and
  a recording is active).
- `DELETE /replay/record/feature/:id` — write a `kind = 'removed'` marker
  for that UID (called from `AtlasDatabase.remove()`).

These bypass TAK Server and `connection-pool.ts` entirely — the feature is
captured into the active recording without ever being broadcast live.
`replay_cot.kind` distinguishes an ordinary snapshot (`'cot'`, the default)
from a `'removed'` marker; playback treats the most recent row per UID as
authoritative for "what does this feature look like at time T".

### Playback

`api/lib/replay-player.ts` (`Player`) runs one `PlaybackControl` session per
active playback, driven entirely by the routes in `replay.ts` — it isn't
hooked into any live stream. On each tick it selects, per UID, the most
recent `replay_cot` row at-or-before the session's virtual clock, rewrites
`time`/`start`/`stale` to the current wall clock (preserving the original
stale offset), and republishes it to the requesting user's own connection
via `config.conns.cots(pooledClient.config, cots, { replay: true })`. A
seek/jump does a full resync (`DISTINCT ON (uid) ... ORDER BY recorded_at
DESC`); a normal tick only publishes what's newly crossed since the last
tick, so one-time side effects (e.g. a fileshare/data-package announcement)
fire once instead of repeating every second for the rest of playback.

### Web Worker recording-active state

`AtlasDatabase` runs in its own Web Worker realm and can't read a
main-thread Vue reactive singleton directly — a Worker gets its own
instance per realm, and mutations don't cross the boundary. `ReplayPanel.vue`
pushes recording state across explicitly via a Comlink RPC,
`mapStore.worker.db.setRecordingActive(active)`, every time
`refreshRecordingStatus()` runs (on mount, and after start/stop). The
worker also checks `/api/replay/record/status` once at boot
(`AtlasDatabase.load()`), since a page reload gets a fresh worker instance
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

## Using it

**Start a recording**
1. Open the Replay panel, type an event name (e.g. "KSF 2026"), click
   **Record**. A red "RECORDING: \<name\>" banner appears at the bottom of
   the map for as long as it's active — recording continues server-side
   even if you close the panel or navigate away.
2. Draw/share features as normal. Anything Shared to a Mission or sent as
   live traffic is captured via the `connection-pool.ts` tap; anything
   drawn but not Shared is captured via the direct-write route.

**Stop a recording**
- Reopen the Replay panel and click **Stop**. The event is now listed under
  "Recorded events" and available for playback/export.

**Play one back**
1. Pick the event from the dropdown, click **Start Playback**. Your own
   live features are hidden for the duration (except your self-marker) and
   a red "REPLAY: \<name\>" banner appears.
2. Use Pause/Play, the back button (rewinds 30 real seconds, scaled by
   speed), the scrubber, the speed selector (1x–50x), and the category
   checkboxes to control what plays and how fast.
3. Click **Stop** (or let it run to the end) to restore your live features
   and remove the banner.

**Delete a recorded event**
- Select it in the dropdown and click **Delete**, then confirm. This is
  permanent — it removes the `replay_events` row and cascades to delete all
  of its `replay_cot` rows.

## Known limitation: deletions by other mission members

Recording only reliably captures a feature *disappearing* when the local
user is the one who deleted it — that goes through the direct-write
`kind = 'removed'` marker described above. When a **different** member of a
shared Mission deletes a feature that was genuinely Shared/broadcast (real
CoT traffic through TAK Server, not a local direct-write), there's no
equivalent marker: real CoT delete tasking (`t-x-d-d`) is not reliably
delivered end-to-end, per TAK Product Center guidance. In that case the
feature is simply never seen again in the live stream — recording has no
signal that it was deleted rather than just quiet — so on playback it stays
at its last known position/state and goes stale naturally (per its own
`stale` timestamp) instead of disappearing at the moment it was actually
deleted.

Upstream CloudTAK PR [#1598](https://github.com/dfpc-coe/CloudTAK/pull/1598)
adds broader `t-x-d-d` support to CloudTAK core. It's related to this gap
but this plugin doesn't rely on it or assume its behavior — worth revisiting
once/if it lands, but not a dependency today.
