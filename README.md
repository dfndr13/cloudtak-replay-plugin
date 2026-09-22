# CloudTAK Replay Plugin

Record and play back CoT (Cursor-on-Target) traffic in
[CloudTAK](https://github.com/dfpc-coe/CloudTAK), for training and
after-action review.

This repo is a **standalone packaging** of the plugin's source, meant as a
clean reference/distribution point — it is not itself a runnable CloudTAK
instance. It was developed against `dfpc-coe/CloudTAK` (this release against
13.69.0, the CloudTAK 13.45+ stateful/stateless hub/api split).

## What's in this repo

- **`plugin/replay/`** — the plugin itself: a self-contained CloudTAK
  frontend plugin (Vue panel, map banners, shared reactive state). See
  [`plugin/replay/README.md`](plugin/replay/README.md) for full
  architecture, usage instructions, and known issues.
- **`core-integration/`** — the pieces that don't live in the plugin folder
  because they belong to CloudTAK's core codebase: files this plugin owns
  outright (recorder, player, routes, a retention task, a test), and four
  small additive patches against existing core files. See
  [`core-integration/README.md`](core-integration/README.md) for exactly
  where each one goes in a CloudTAK checkout.
- **`install.sh`** — copies everything into place and applies/reverses the
  core patches for you. See `./install.sh --help`.

## Requirements

- CloudTAK >= 13.45 (the stateful/stateless hub/api split — this plugin's
  routes and libraries are written against that layout and will not apply to
  an older tree).
- `CLOUDTAK_Server_Mode=both` (CloudTAK's own `docker-compose.yml` default).
  Recording taps `ConnectionPool.cots()` on the stateful side; there's no Hub
  RPC equivalent for a true split stateful/stateless deployment, so **new
  recording is unavailable in standalone `api` mode** (playback, export, and
  import of already-recorded events still work — only starting a new
  recording needs the stateful process co-located).

## Summary

- Records all CoT traffic flowing through a CloudTAK instance under a
  named event, including features a user draws/authors locally — even ones
  linked to an active Mission — even if they're never Shared/broadcast live.
- Plays a recorded event back on demand — pause/resume, seek, adjustable
  speed (at start), filter by category — as a private preview visible only
  to the user running playback.
- Distinguishes replay-sourced features from live traffic while playback
  is running, and never feeds a replay back into a concurrently active
  recording of a different session.
- Exports/imports recordings as portable JSON files so they can be shared
  between CloudTAK instances.

See [`plugin/replay/README.md`](plugin/replay/README.md) for the full
write-up, including known issues.

## Changelog

### v1.1.0

Repackaged from the CloudTAK checkout's local `main` branch (13 commits,
unpushed at packaging time — never previously released past v1.0.0) after an
independent review turned up several bugs already fixed in that branch but
never folded back into this repo. Net effect vs. v1.0.0:

- **Re-platformed onto the stateful/stateless hub/api split.** v1.0.0's core
  files (`api/lib/*`, `api/routes/replay.ts`) target pre-13.45 CloudTAK and
  will not apply to a current checkout. This release moves recording
  (`Recorder`) to `api/stateful/lib/`, playback/routes to `api/stateless/`,
  and playback now reaches the requesting user's browser session via
  `config.hub.submitCots({ write: false, broadcast: true, replay: true })`
  instead of a direct `ConnectionPool` reference the stateless process no
  longer has. `config.recorder` is carried from the stateful process into
  `ConfigStateless` at boot, only in combined `both` mode (see Requirements).
- **Fixed: playback crashing on a deletion marker.** A `kind = 'removed'` row
  (see "direct-write deletion capture" below) used to be handed straight to
  `CoTParser.from_xml()` with an empty XML string, throwing an unhandled
  rejection that could take down the whole API process — not just that
  playback session. It's now turned into a `ForceDelete` task, and both the
  per-row parse and the per-tick publish are wrapped so one bad row can't
  crash a session, let alone the process.
- **Fixed: playback recording itself.** `ConnectionPool.cots()` used to call
  `recorder.record()` unconditionally whenever a recording was active,
  regardless of whether the CoTs it just received were replay output. If you
  played back an event while a recording was active, the replay got written
  into the live recording. Recording now explicitly skips `opts.replay`
  traffic.
- **Fixed: pre-existing and Mission-linked content invisible to replay.**
  Starting a recording now snapshots every currently-live feature (plain and
  Mission-linked) into the new event so pre-existing state has a baseline
  instead of only whatever changes during the recording. Mission-linked
  drawn/authored features (previously invisible to both the `cots()` tap and
  the direct-write capture, since they're stored via `subscription_feature`
  and never broadcast their own CoT) are now direct-written. Deletions
  reported by TAK Server's Mission `REMOVE_CONTENT` change notification are
  now captured too — including ones made by *other* Mission members, not
  just this user's own deletes. On the viewing side, the hide/show sweep at
  playback start and during playback was also blind to Mission-linked
  content (it only ever read the plain feature table), so it never got
  hidden as "live" and never got exemption-tracked as replay — it just sat
  visible throughout regardless of replay state. It now merges in
  `subscription_feature` alongside the plain table.
- **Fixed: replay's hide/show sweep colliding with unrelated visibility
  state.** `FeatureVisibility` is one flat store shared with the rest of the
  app (e.g. Mission Layers' own hide/show toggle) with no concept of *why* a
  feature is hidden. The sweep used to track every currently-hidden UID as
  "hidden by replay," so ending playback would force-unhide anything that
  happened to already be hidden for an unrelated reason (like a Mission
  Layer the user had toggled off) when playback started. It now only tracks
  UIDs it hides itself.
- **Fixed: a UID that reverts from replay back to genuinely live mid-session
  stayed exempt from hiding.** E.g. an asset still reporting a live position
  while an earlier window of its own history plays back. The exemption set
  now releases a UID as soon as it sees a non-replay update for it, so it
  goes back through the normal hide sweep instead of staying visible
  indefinitely.
- **Fixed: leaving the Replay panel while playback is running left the
  session ticking server-side** until the 30s idle-timeout reaper above
  caught it. `onUnmounted` now tells the server to stop the session
  immediately (best-effort; the reaper is still the backstop).
- **Fixed: abandoned playback sessions never cleaned up.** A closed
  tab/crash/network loss never calls `stop()`, so an in-memory
  `PlaybackControl` used to tick forever. Sessions are now reaped after 30s
  without a status poll (the only recurring liveness signal this design
  gets).
- **Fixed: expired tracks resurrected on replay.** A feed that just stopped
  sending updates mid-recording (no explicit removal marker) used to get a
  brand-new future `stale` time on every tick for the rest of playback,
  instead of staying gone the way it actually did in the original session.
  Playback now checks the row's own recorded stale window against the
  virtual clock and skips it once expired.
- **Added: configurable retention.** A `replay` retention task
  (`retention::replay::days`, default 10) deletes `replay_events` older than
  the cutoff; `replay_cot` cascades via FK.
- Carried forward unchanged from v1.0.0: feature-hiding tag fix, persisted
  per-feature `replay` flag fix, poll race-condition fix, `publishStateAt`
  watermark fix (see below).

**Known issues, not yet fixed in this release** (tracked for the next
release — see `plugin/replay/README.md` for detail):
- Export/import silently drops deletion markers (`kind` isn't in the export
  SELECT or the import INSERT), so an imported recording can't show a
  feature disappearing even though local playback now can.
- The UAS category checkbox has no effect — `categorize()`'s `how` parameter
  is always called as `undefined`, so every air track files as `aircraft`.

### v1.0.0

Fixes found and applied while testing the plugin end-to-end (Jul 14-20
sessions), folded into the initial packaged release:

- **Feature-hiding fix** — replayed CoTs are tagged
  (`ConnectionPool.cots()` `opts.replay`) so the client can tell them apart
  from genuine live traffic. Before this, live-feature hiding at playback
  start was indiscriminate and could catch replayed features in the same
  hide as real live ones.
- **Persisted-flag fix** — `properties.replay` is a per-feature flag that
  sticks on a UID once set, so checking it alone would treat a UID touched
  by a completely unrelated *previous* playback session as still exempt from
  hiding forever. Each session now rebuilds its exemption set from scratch,
  confirming membership by the CoT's own generation timestamp advancing
  rather than by the sticky flag.
- **Poll race condition fix** — the panel's per-second poll (which
  reconciles hidden vs. exempt features) could fire in the same window
  as a session ending naturally, re-hiding everything
  `restoreLiveFeatures()` had just restored. The poll loop now bails as
  soon as the session is over instead of running one more reconciliation
  pass against a session that no longer exists.
- **`publishStateAt` watermark fix** — playback used to republish every
  CoT touched since the recording began on every tick, so one-time
  events (e.g. a recorded data-package/fileshare announcement) re-fired
  roughly once a second for the rest of playback instead of once.
  `Player.publishStateAt` now republishes only what's newly crossed the
  virtual clock since the last tick.
