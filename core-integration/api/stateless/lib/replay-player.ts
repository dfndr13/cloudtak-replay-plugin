// api/lib/replay-player.ts
//
// SIMPLIFIED: no dedicated layer certs, no tak.write() to real TAK Server.
// Playback broadcasts to the requesting user's OWN browser session only,
// using their existing ProfileConnConfig (config.conns.get(user.email)) -
// the same identity/connection they already have for normal live use.
// Nothing is written to TAK Server; nobody else sees replayed data. This
// is a private preview for the user who started playback, matching
// "just let me see what this looks like" rather than a shared/published
// feature - the layer-cert approach can be revisited later if/when this
// needs to be visible to other users or persist in TAK Server.

import CoT, { CoTParser, ForceDelete } from '@tak-ps/node-cot';
import type ConfigStateless from '../config.js';
import { sql } from 'drizzle-orm';

type ReplayCategory = 'aircraft' | 'uas' | 'ground' | 'maritime' | 'other';

// ReplayPanel.vue polls GET status every 1s for as long as its session is
// active, so silence on status() is a reliable disconnect signal - covers
// tab closes/crashes/network loss, none of which fire any close/unmount
// hook the server could otherwise catch. Generous margin above the 1s poll
// interval to tolerate normal jitter (slow requests, a dev-tools breakpoint)
// without reaping a still-attached session.
const SESSION_IDLE_TIMEOUT_MS = 30_000;

function categorize(cotType: string, how?: string): ReplayCategory {
    if (!cotType.startsWith('a-')) return 'other';
    const dim = cotType.split('-')[2];

    if (dim === 'A') {
        if (how === 'm-u') return 'uas';
        return 'aircraft';
    }
    if (dim === 'G') return 'ground';
    if (dim === 'S' || dim === 'U') return 'maritime';
    return 'other';
}

// Pulled out of rewriteTimestamps() so publishStateAt() can also use the
// original stale window to decide whether a row has already expired as of
// virtualNow (see the staleness check in publishStateAt), without duplicating
// the same regex parsing twice.
function computeStaleOffsetMs(xml: string): number {
    const timeMatch = xml.match(/\stime="([^"]*)"/);
    const staleMatch = xml.match(/\sstale="([^"]*)"/);

    if (timeMatch && staleMatch) {
        const origTime = new Date(timeMatch[1]).getTime();
        const origStale = new Date(staleMatch[1]).getTime();
        if (!isNaN(origTime) && !isNaN(origStale) && origStale > origTime) {
            return origStale - origTime;
        }
    }
    return 30_000;
}

function rewriteTimestamps(xml: string, playbackNow: Date, staleOffsetMs: number): string {
    const newTime = playbackNow.toISOString();
    const newStale = new Date(playbackNow.getTime() + staleOffsetMs).toISOString();

    return xml
        .replace(/\stime="[^"]*"/, ` time="${newTime}"`)
        .replace(/\sstart="[^"]*"/, ` start="${newTime}"`)
        .replace(/\sstale="[^"]*"/, ` stale="${newStale}"`);
}

export interface PlaybackControl {
    sessionId: string;
    eventId: number;
    username: string;
    windowStart: Date;
    windowEnd: Date;
    speed: number;
    paused: boolean;
    virtualNow: Date;
    // High-water mark of what's already been published. Ticks only publish
    // (lastPublishedAt, virtualNow] so a CoT with one-time side effects (e.g.
    // a fileshare/data-package announcement) fires once, not on every tick
    // for the rest of playback. Seeking/jumping resets this to virtualNow
    // after a full resync, so playback resumes delta-only from the new point.
    lastPublishedAt: Date;
    activeCategories: Set<ReplayCategory>;
    // Last time the client polled status() for this session - the only
    // recurring signal the server gets that a client is still attached.
    // Used by tick() to reap sessions abandoned by a disconnect that never
    // called stop() (see SESSION_IDLE_TIMEOUT_MS).
    lastSeen: Date;
}

interface ReplayCotRow {
    uid: string;
    cot_type: string | null;
    cot_xml: string;
    recorded_at: string;
    kind: string;
}

export default class Player {
    config: ConfigStateless;
    sessions: Map<string, PlaybackControl> = new Map();

    constructor(config: ConfigStateless) {
        this.config = config;
    }

    async start(eventId: number, username: string, windowStart: Date, windowEnd: Date, speed = 1): Promise<string> {
        const sessionId = crypto.randomUUID();

        this.sessions.set(sessionId, {
            sessionId,
            eventId,
            username,
            windowStart,
            windowEnd,
            speed,
            paused: false,
            virtualNow: windowStart,
            // 1ms before windowStart so a CoT recorded exactly at windowStart
            // is included in the first tick's (lastPublishedAt, virtualNow] window.
            lastPublishedAt: new Date(windowStart.getTime() - 1),
            activeCategories: new Set(['aircraft', 'uas', 'ground', 'maritime', 'other']),
            lastSeen: new Date(),
        });

        this.tick(sessionId);
        return sessionId;
    }

    pause(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (s) s.paused = true;
    }

    resume(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (s) {
            s.paused = false;
            this.tick(sessionId);
        }
    }

    setCategory(sessionId: string, category: ReplayCategory, on: boolean) {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        if (on) s.activeCategories.add(category);
        else s.activeCategories.delete(category);
    }

    stop(sessionId: string) {
        this.sessions.delete(sessionId);
    }

    status(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) return null;
        const totalMs = s.windowEnd.getTime() - s.windowStart.getTime();
        const elapsedMs = s.virtualNow.getTime() - s.windowStart.getTime();
        const percent = totalMs > 0 ? Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100)) : 0;
        s.lastSeen = new Date();
        return {
            active: true,
            paused: s.paused,
            percent,
            virtualNow: s.virtualNow.toISOString(),
            windowStart: s.windowStart.toISOString(),
            windowEnd: s.windowEnd.toISOString(),
            speed: s.speed,
        };
    }

    seek(sessionId: string, target: Date) {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        const clamped = new Date(Math.min(Math.max(target.getTime(), s.windowStart.getTime()), s.windowEnd.getTime()));
        s.virtualNow = clamped;
        s.paused = true;
        // Jumping to an arbitrary (possibly earlier) point needs a full resync
        // of "what's true as of here", not a delta off the old watermark.
        // Fire-and-forget, same as tick()'s call below - back()/seekPercent()
        // both funnel through here, so this one catch covers all three public
        // entry points against the same unhandled-rejection crash risk tick()
        // already guards against.
        this.publishStateAt(s, { fullSnapshot: true }).catch((err) => {
            console.error(`[replay] seek failed for session ${sessionId}:`, err);
        });
    }

    back(sessionId: string, wallSeconds = 30) {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        const recordedSecondsBack = wallSeconds * s.speed;
        this.seek(sessionId, new Date(s.virtualNow.getTime() - recordedSecondsBack * 1000));
    }

    seekPercent(sessionId: string, percent: number) {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        const clampedPct = Math.min(Math.max(percent, 0), 100) / 100;
        const totalMs = s.windowEnd.getTime() - s.windowStart.getTime();
        this.seek(sessionId, new Date(s.windowStart.getTime() + totalMs * clampedPct));
    }

    private async tick(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) return;

        // No client has polled status() (the only recurring liveness signal
        // this stateless-REST session design gets) in too long - the client
        // disconnected (tab closed, crash, network loss) without ever
        // calling stop(). Clean up the same way stop() does instead of
        // ticking this session forever.
        if (Date.now() - s.lastSeen.getTime() > SESSION_IDLE_TIMEOUT_MS) {
            console.warn(`[replay] session ${sessionId} idle for over ${SESSION_IDLE_TIMEOUT_MS}ms, reaping abandoned playback`);
            this.sessions.delete(sessionId);
            return;
        }

        if (s.paused) {
            setTimeout(() => this.tick(sessionId), 1000);
            return;
        }

        try {
            await this.publishStateAt(s);
        } catch (err) {
            // Never let a bad tick kill the whole process (previously a
            // single malformed/unexpected row here took down the entire
            // Node process via an unhandled rejection, 502ing every route -
            // not just replay - until Docker restarted the container).
            // Playback still advances below so it doesn't get stuck
            // retrying the same failing tick forever.
            console.error(`[replay] tick failed for session ${sessionId}:`, err);
        }

        s.virtualNow = new Date(s.virtualNow.getTime() + 1000 * s.speed);

        if (s.virtualNow >= s.windowEnd) {
            this.sessions.delete(sessionId);
            return;
        }

        setTimeout(() => this.tick(sessionId), 1000);
    }

    private async publishStateAt(s: PlaybackControl, opts: { fullSnapshot?: boolean } = {}) {
        // Regular ticks only publish what's newly crossed since the last publish
        // - not the full cumulative history every tick - so a CoT with a one-time
        // side effect (e.g. a fileshare/data-package announcement, which triggers
        // a real import) fires once instead of repeating every ~1s for the rest
        // of playback. A seek/jump instead asks for a full resync (fullSnapshot),
        // since the client's view no longer matches the new point in time.
        // Both 'cot' and 'removed' kinds are fetched here (unlike the earlier
        // version of this query, which excluded 'removed' entirely to avoid
        // crashing on its empty cot_xml). DISTINCT ON (uid) now correctly picks
        // a 'removed' row as the latest state for a uid once it's been deleted,
        // and the loop below turns that into a ForceDelete rather than ever
        // calling CoTParser.from_xml() on its empty cot_xml.
        const query = opts.fullSnapshot
            ? sql`
                SELECT DISTINCT ON (uid) uid, cot_type, cot_xml, recorded_at, kind
                FROM replay_cot
                WHERE event = ${s.eventId}
                  AND recorded_at <= ${s.virtualNow.toISOString()}
                ORDER BY uid, recorded_at DESC
            `
            : sql`
                SELECT DISTINCT ON (uid) uid, cot_type, cot_xml, recorded_at, kind
                FROM replay_cot
                WHERE event = ${s.eventId}
                  AND recorded_at > ${s.lastPublishedAt.toISOString()}
                  AND recorded_at <= ${s.virtualNow.toISOString()}
                ORDER BY uid, recorded_at DESC
            `;

        const rows = await this.config.pg.execute(query) as unknown as ReplayCotRow[];

        s.lastPublishedAt = s.virtualNow;

        const cots: CoT[] = [];
        for (const row of rows) {
            // 'removed' rows (Recorder.recordRemoval()) carry no usable cot_xml/
            // cot_type - never hand them to CoTParser.from_xml(). Turn them into
            // a ForceDelete task instead, which flows through the same
            // submitCots()/ConnectionPool.cots() path as a real t-x-d-d delete
            // and is handled client-side by atlas-connection.ts. Sent regardless
            // of category filtering since cot_type is unknown (NULL) for these
            // rows - a removal for a uid the client doesn't have is a no-op there.
            if (row.kind === 'removed') {
                cots.push(new ForceDelete(row.uid));
                continue;
            }

            const category = categorize(row.cot_type || '', undefined);
            if (!s.activeCategories.has(category)) continue;

            // Defense in depth: any other unexpected/malformed cot_xml (e.g. from
            // an older export/import, or a future bug) skips just this one row
            // instead of throwing an unhandled rejection that kills the whole
            // tick - and, before the try/catch in tick() above, the whole process.
            try {
                const staleOffsetMs = computeStaleOffsetMs(row.cot_xml);

                // A row whose own recorded stale window had already elapsed by
                // this point in the original recording (e.g. a feed - like a
                // camera integration - that just stopped sending updates, with
                // no explicit removal marker ever written) shouldn't be
                // resurrected as freshly-live just because it's still the latest
                // row before virtualNow. Skipping it lets it stay gone, matching
                // what actually happened in the original session, instead of
                // rewriteTimestamps() below handing it a brand new future stale
                // time on every publish.
                if (new Date(row.recorded_at).getTime() + staleOffsetMs < s.virtualNow.getTime()) continue;

                const rewritten = rewriteTimestamps(row.cot_xml, new Date(), staleOffsetMs);
                cots.push(await CoTParser.from_xml(rewritten));
            } catch (err) {
                console.error(`[replay] skipping unparseable row for uid ${row.uid}:`, err);
            }
        }

        if (cots.length === 0) return;

        // write: false / broadcast: true - playback must never reach the real
        // TAK Server (see file header); it should only reach the requesting
        // user's own browser session, via the same wsClients broadcast path
        // (ConnectionPool.cots()) their normal live CoT traffic already uses.
        await this.config.hub.submitCots({
            connection: s.username,
            cots,
            ensureProfile: true,
            write: false,
            broadcast: true,
            replay: true,
        });
    }
}
