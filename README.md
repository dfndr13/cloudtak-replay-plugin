# CloudTAK Replay Plugin

Record and play back CoT (Cursor-on-Target) traffic in
[CloudTAK](https://github.com/dfpc-coe/CloudTAK), for training and
after-action review.

This repo is a **standalone packaging** of the plugin's source, meant as a
clean reference/distribution point — it is not itself a runnable CloudTAK
instance. It was developed against `dfpc-coe/CloudTAK`.

## What's in this repo

- **`plugin/replay/`** — the plugin itself: a self-contained CloudTAK
  frontend plugin (Vue panel, map banners, shared reactive state). See
  [`plugin/replay/README.md`](plugin/replay/README.md) for full
  architecture, usage instructions, and known limitations.
- **`core-integration/`** — the handful of pieces that don't live in the
  plugin folder because they belong to CloudTAK's core codebase: two new
  files (`replay-recorder.ts`, `replay-player.ts`, and the `/replay/*`
  routes file) and two small additive patches against existing core files
  (`connection-pool.ts`, `atlas-database.ts`). See
  [`core-integration/README.md`](core-integration/README.md) for exactly
  where each one goes in a CloudTAK checkout and how to apply the patches.

## Summary

- Records all CoT traffic flowing through a CloudTAK instance under a
  named event, including features a user draws/authors locally even if
  they're never Shared to a Mission.
- Plays a recorded event back on demand — pause/resume, seek, adjustable
  speed, filter by category — as a private preview visible only to the
  user running playback.
- Distinguishes replay-sourced features from live traffic while playback
  is running.
- Exports/imports recordings as portable JSON files so they can be shared
  between CloudTAK instances.

See [`plugin/replay/README.md`](plugin/replay/README.md) for the full
write-up, including the known limitation around deletions made by other
Mission members (`t-x-d-d` CoT delete tasking isn't reliably delivered)
and a note on upstream CloudTAK PR
[#1598](https://github.com/dfpc-coe/CloudTAK/pull/1598).

## Changelog

### v1.0.0

Fixes found and applied while testing the plugin end-to-end (Jul 14-20
sessions), folded into this initial packaged release:

- **Feature-hiding fix** — replayed CoTs are tagged
  (`ConnectionPool.cots` `opts.replay`) so the client can tell them apart
  from genuine live traffic. Before this, live-feature hiding at playback
  start was indiscriminate and could catch replayed features in the same
  hide as real live ones.
- **Persisted-flag fix** — `properties.replay = true` is a per-feature
  flag that sticks on a UID once set, so checking it alone would treat a
  UID touched by a completely unrelated *previous* playback session as
  still exempt from hiding forever. Each session now rebuilds its
  exemption set from scratch, confirming membership by the CoT's own
  generation timestamp advancing rather than by the sticky flag.
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
