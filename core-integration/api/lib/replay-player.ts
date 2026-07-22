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

import CoT, { CoTParser } from '@tak-ps/node-cot';
import Config from './config.js';
import { sql } from 'drizzle-orm';
import { ProfileConnConfig } from './connection-config.js';

type ReplayCategory = 'aircraft' | 'uas' | 'ground' | 'maritime' | 'other';

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

function rewriteTimestamps(xml: string, playbackNow: Date): string {
    const timeMatch = xml.match(/\stime="([^"]*)"/);
    const staleMatch = xml.match(/\sstale="([^"]*)"/);

    let staleOffsetMs = 30_000;
    if (timeMatch && staleMatch) {
        const origTime = new Date(timeMatch[1]).getTime();
        const origStale = new Date(staleMatch[1]).getTime();
        if (!isNaN(origTime) && !isNaN(origStale) && origStale > origTime) {
            staleOffsetMs = origStale - origTime;
        }
    }

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
}

interface ReplayCotRow {
    uid: string;
    cot_type: string | null;
    cot_xml: string;
    recorded_at: string;
}

export default class Player {
    config: Config;
    sessions: Map<string, PlaybackControl> = new Map();

    constructor(config: Config) {
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
        this.publishStateAt(s, { fullSnapshot: true });
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
        if (s.paused) {
            setTimeout(() => this.tick(sessionId), 1000);
            return;
        }

        await this.publishStateAt(s);

        s.virtualNow = new Date(s.virtualNow.getTime() + 1000 * s.speed);

        if (s.virtualNow >= s.windowEnd) {
            this.sessions.delete(sessionId);
            return;
        }

        setTimeout(() => this.tick(sessionId), 1000);
    }

    private async publishStateAt(s: PlaybackControl, opts: { fullSnapshot?: boolean } = {}) {
        let pooledClient = this.config.conns.get(s.username);
        if (!pooledClient) {
            const rawProfile = await this.config.models.Profile.from(s.username);
            if (!rawProfile.auth?.cert || !rawProfile.auth?.key) return;
            pooledClient = await this.config.conns.add(
                new ProfileConnConfig(this.config, s.username, rawProfile.auth),
            );
            if (!pooledClient) return;
        }

        // Regular ticks only publish what's newly crossed since the last publish
        // - not the full cumulative history every tick - so a CoT with a one-time
        // side effect (e.g. a fileshare/data-package announcement, which triggers
        // a real import) fires once instead of repeating every ~1s for the rest
        // of playback. A seek/jump instead asks for a full resync (fullSnapshot),
        // since the client's view no longer matches the new point in time.
        const query = opts.fullSnapshot
            ? sql`
                SELECT DISTINCT ON (uid) uid, cot_type, cot_xml, recorded_at
                FROM replay_cot
                WHERE event = ${s.eventId}
                  AND recorded_at <= ${s.virtualNow.toISOString()}
                ORDER BY uid, recorded_at DESC
            `
            : sql`
                SELECT DISTINCT ON (uid) uid, cot_type, cot_xml, recorded_at
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
            const category = categorize(row.cot_type || '', undefined);
            if (!s.activeCategories.has(category)) continue;

            const rewritten = rewriteTimestamps(row.cot_xml, new Date());
            cots.push(await CoTParser.from_xml(rewritten));
        }

        if (cots.length === 0) return;

        this.config.conns.cots(pooledClient.config, cots, { replay: true });
    }
}
