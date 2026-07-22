// api/routes/replay.ts
//
// CloudTAK lints copied plugin routes with its OWN house-style rules, which differ across
// versions: @stylistic/brace-style flips between 13.2 (Stroustrup) and 13.3 (1TBS), and
// isn't even defined on 12.82 (naming it in a disable errors there). A plugin can't satisfy
// every CloudTAK version, so opt this route file out of CloudTAK's lint — the plugin repo
// owns its correctness (vue-tsc/eslint in dev).
/* eslint-disable */
import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../lib/auth.js';
import Config from '../lib/config.js';
import { CoTParser } from '@tak-ps/node-cot';
import { bootstrapReplayTables } from '../lib/replay-recorder.js';
import Player from '../lib/replay-player.js';

// Event-scoped CoT recording/playback. Owns replay_events + replay_cot via
// CREATE TABLE IF NOT EXISTS (config.pg is the raw Postgres handle, same
// pattern as plugin-dispatcher.ts) — does not touch CloudTAK's own Drizzle
// schema/migrations, and does not touch config.ts.
//
// Recording hook (Recorder, in ../lib/replay-recorder.ts) taps
// ConnectionPool.cots() directly and is instantiated on ConnectionPool
// itself — see README "Installing" for the one-line wiring change that
// requires (the one CloudTAK core file this plugin does edit).
//
// Playback (Player, in ../lib/replay-player.ts) is a singleton scoped to
// this route file, NOT attached to config - it doesn't need to hook a live
// stream like Recorder does, it's only ever driven by these routes. It
// broadcasts replayed CoT to the requesting user's own live browser
// session only (config.conns.cots(), no tak.write()) - private preview,
// nothing sent to real TAK Server, nobody else sees it unless they import
// the exported event file into their own CloudTAK and replay it locally.

let playerInstance: Player | null = null;
function getPlayer(config: Config): Player {
    if (!playerInstance) playerInstance = new Player(config);
    return playerInstance;
}

interface ReplayEventRow {
    id: number;
    name: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    username: string;
}

interface ReplayCotExportRow {
    connection: number | null;
    source: string;
    uid: string;
    cot_type: string | null;
    recorded_at: string;
    sha256: string;
    cot_xml: string;
}

const Category = Type.Union([
    Type.Literal('aircraft'),
    Type.Literal('uas'),
    Type.Literal('ground'),
    Type.Literal('maritime'),
    Type.Literal('other'),
]);

export default async function router(schema: Schema, config: Config) {
    await bootstrapReplayTables(config);

    // --- Recording -----------------------------------------------------

    await schema.post('/replay/record/start', {
        name: 'Start Recording',
        group: 'Replay',
        description: 'Begin recording all CoT traffic under a named event',
        body: Type.Object({
            name: Type.String({ description: 'e.g. "KSF 2026"' }),
        }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            const id = await config.conns.recorder.start(req.body.name, user.email);
            res.json({ id, name: req.body.name });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/replay/record/stop', {
        name: 'Stop Recording',
        group: 'Replay',
        description: 'Stop the currently active recording, if any',
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            const wasActive = config.conns.recorder.active();
            await config.conns.recorder.stop();
            res.json({ stopped: wasActive });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/replay/record/status', {
        name: 'Recording Status',
        group: 'Replay',
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            await config.conns.recorder.refresh();
            res.json({
                active: config.conns.recorder.active(),
                event: config.conns.recorder.activeEvent || undefined,
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    // --- Direct-write capture (drawn/authored features, no live broadcast) ---
    //
    // Drawn shapes that are never Shared don't pass through ConnectionPool.cots(),
    // so Recorder.record() never sees them. These two routes let the browser hand
    // a feature's GeoJSON straight to Recorder, bypassing TAK Server and
    // connection-pool.ts entirely - the feature is captured into the active
    // recording without being broadcast live to anyone else.

    await schema.post('/replay/record/feature', {
        name: 'Record Drawn Feature',
        group: 'Replay',
        description: `
            Directly capture a drawn/authored feature's current state into the
            active recording. Bypasses TAK Server and connection-pool.ts entirely -
            nothing is broadcast live. No-op if no recording is active.
        `,
        body: Type.Object({
            id: Type.String(),
            type: Type.Literal('Feature'),
            // Record, not Type.Object({...}, { additionalProperties: true }):
            // batch-schema's ajv instance is configured with
            // removeAdditional: 'all', which strips unenumerated properties
            // regardless of additionalProperties - silently dropping things
            // like shape/stroke/fill and breaking CoTParser.from_geojson for
            // e.g. circles ("must define a feature.properties.shape.ellipse
            // property"). A Record has no fixed property list, so nothing
            // counts as "additional" and nothing gets stripped. Matches the
            // same pattern already used for GeoJSONFeature in lib/types.ts.
            properties: Type.Record(Type.String(), Type.Unknown()),
            geometry: Type.Unknown(),
        }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            if (!config.conns.recorder.active()) {
                res.json({ recorded: false });
                return;
            }

            const cot = await CoTParser.from_geojson(req.body as Parameters<typeof CoTParser.from_geojson>[0]);
            const xml = await CoTParser.to_xml(cot);
            await config.conns.recorder.recordDirect(req.body.id, cot.type(), xml);

            res.json({ recorded: true });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.delete('/replay/record/feature/:id', {
        name: 'Record Feature Removal',
        group: 'Replay',
        description: `
            Mark a drawn/authored feature as removed at the current point in the
            active recording, so playback shows it disappearing rather than
            leaving its last known state on the map forever. No-op if no
            recording is active.
        `,
        params: Type.Object({ id: Type.String() }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            if (!config.conns.recorder.active()) {
                res.json({ recorded: false });
                return;
            }

            await config.conns.recorder.recordRemoval(req.params.id);

            res.json({ recorded: true });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    // --- Browsing recorded events ---------------------------------------

    await schema.get('/replay/event', {
        name: 'List Events',
        group: 'Replay',
        description: 'List all recorded events, most recent first',
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            const rows = await config.pg.execute(sql`
                SELECT id, name, started_at, ended_at, status, username
                FROM replay_events ORDER BY started_at DESC
            `) as unknown as ReplayEventRow[];
            res.json({ events: rows });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    // --- Playback --------------------------------------------------------

    await schema.post('/replay/event/:eventid/play', {
        name: 'Start Playback',
        group: 'Replay',
        description: 'Begin playback of a recorded event on your own map view (private preview - not sent to TAK Server or other users)',
        params: Type.Object({ eventid: Type.Integer() }),
        body: Type.Object({
            start: Type.Optional(Type.String({ description: 'ISO timestamp; defaults to event start' })),
            end: Type.Optional(Type.String({ description: 'ISO timestamp; defaults to event end' })),
            speed: Type.Number({ default: 1, minimum: 0.25, maximum: 120 }),
        }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);

            const rows = await config.pg.execute(sql`
                SELECT id, name, started_at, ended_at, status, username
                FROM replay_events WHERE id = ${req.params.eventid} LIMIT 1
            `) as unknown as ReplayEventRow[];
            if (!rows.length) throw new Err(404, null, 'Event not found');
            const event = rows[0];

            const windowStart = req.body.start ? new Date(req.body.start) : new Date(event.started_at);
            const windowEnd = req.body.end ? new Date(req.body.end) : new Date(event.ended_at || Date.now());

            const sessionId = await getPlayer(config).start(
                req.params.eventid, user.email, windowStart, windowEnd, req.body.speed,
            );

            res.json({ sessionId });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/replay/session/:sessionid/pause', {
        name: 'Pause Playback',
        group: 'Replay',
        params: Type.Object({ sessionid: Type.String() }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            getPlayer(config).pause(req.params.sessionid);
            res.json({ ok: true });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/replay/session/:sessionid/resume', {
        name: 'Resume Playback',
        group: 'Replay',
        params: Type.Object({ sessionid: Type.String() }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            getPlayer(config).resume(req.params.sessionid);
            res.json({ ok: true });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/replay/session/:sessionid/stop', {
        name: 'Stop Playback',
        group: 'Replay',
        params: Type.Object({ sessionid: Type.String() }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            getPlayer(config).stop(req.params.sessionid);
            res.json({ ok: true });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/replay/session/:sessionid/back', {
        name: 'Back 30s',
        group: 'Replay',
        description: 'Rewind wall-clock seconds, scaled by playback speed; pauses after rewinding',
        params: Type.Object({ sessionid: Type.String() }),
        body: Type.Object({
            wallSeconds: Type.Number({ default: 30 }),
        }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            getPlayer(config).back(req.params.sessionid, req.body.wallSeconds);
            res.json({ ok: true });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/replay/session/:sessionid/seek', {
        name: 'Seek',
        group: 'Replay',
        description: 'Jump to an absolute timestamp or a percentage of the replay window; pauses after seeking',
        params: Type.Object({ sessionid: Type.String() }),
        body: Type.Object({
            timestamp: Type.Optional(Type.String({ description: 'ISO timestamp - absolute seek' })),
            percent: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: 'Percent of window - progress-bar seek' })),
        }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            if (req.body.percent !== undefined) {
                getPlayer(config).seekPercent(req.params.sessionid, req.body.percent);
            } else if (req.body.timestamp) {
                getPlayer(config).seek(req.params.sessionid, new Date(req.body.timestamp));
            } else {
                throw new Err(400, null, 'Provide either timestamp or percent');
            }
            res.json({ ok: true });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/replay/session/:sessionid/category', {
        name: 'Toggle Category',
        group: 'Replay',
        description: 'Turn a replay category layer on/off mid-playback',
        params: Type.Object({ sessionid: Type.String() }),
        body: Type.Object({
            category: Category,
            on: Type.Boolean(),
        }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            getPlayer(config).setCategory(req.params.sessionid, req.body.category, req.body.on);
            res.json({ ok: true });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/replay/session/:sessionid/status', {
        name: 'Playback Status',
        group: 'Replay',
        description: 'Poll current playback progress',
        params: Type.Object({ sessionid: Type.String() }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            const status = getPlayer(config).status(req.params.sessionid);
            res.json(status || { active: false });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    // --- Export / Import (sharing a recording with another CloudTAK) -----

    await schema.get('/replay/event/:eventid/export', {
        name: 'Export Event',
        group: 'Replay',
        description: 'Download a recorded event as a portable JSON file to share with another CloudTAK instance',
        params: Type.Object({ eventid: Type.Integer() }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            const eventRows = await config.pg.execute(sql`
                SELECT id, name, started_at, ended_at, status, username
                FROM replay_events WHERE id = ${req.params.eventid} LIMIT 1
            `) as unknown as ReplayEventRow[];
            if (!eventRows.length) throw new Err(404, null, 'Event not found');
            const event = eventRows[0];

            const cotRows = await config.pg.execute(sql`
                SELECT connection, source, uid, cot_type, recorded_at, sha256, cot_xml
                FROM replay_cot WHERE event = ${req.params.eventid}
                ORDER BY recorded_at ASC
            `) as unknown as ReplayCotExportRow[];

            const filename = `replay-${event.name.replace(/[^A-Za-z0-9-]+/g, '_')}-${event.id}.json`;

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.json({
                format: 'cloudtak-replay-export-v1',
                event: {
                    name: event.name,
                    started_at: event.started_at,
                    ended_at: event.ended_at,
                    exported_by: (await Auth.as_user(config, req)).email,
                    exported_at: new Date().toISOString(),
                },
                cots: cotRows,
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.delete('/replay/event/:eventid', {
        name: 'Delete Event',
        group: 'Replay',
        description: 'Delete a recorded event and its associated CoT rows',
        params: Type.Object({ eventid: Type.Integer() }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            const rows = await config.pg.execute(sql`
                DELETE FROM replay_events WHERE id = ${req.params.eventid}
                RETURNING id
            `) as unknown as { id: number }[];
            if (!rows.length) throw new Err(404, null, 'Event not found');

            res.json({ deleted: true });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/replay/import', {
        name: 'Import Event',
        group: 'Replay',
        description: 'Import a previously exported replay file as a new local event',
        body: Type.Object({
            format: Type.String(),
            event: Type.Object({
                name: Type.String(),
                started_at: Type.String(),
                ended_at: Type.Optional(Type.String()),
            }),
            cots: Type.Array(Type.Object({
                connection: Type.Optional(Type.Integer()),
                source: Type.String(),
                uid: Type.String(),
                cot_type: Type.Optional(Type.String()),
                recorded_at: Type.String(),
                sha256: Type.String(),
                cot_xml: Type.String(),
            })),
        }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);

            if (req.body.format !== 'cloudtak-replay-export-v1') {
                throw new Err(400, null, 'Unrecognized export file format');
            }

            const eventRows = await config.pg.execute(sql`
                INSERT INTO replay_events (name, started_at, ended_at, status, username)
                VALUES (${`${req.body.event.name} (imported)`}, ${req.body.event.started_at},
                        ${req.body.event.ended_at ?? null}, 'stopped', ${user.email})
                RETURNING id, name, started_at, ended_at, status, username
            `) as unknown as ReplayEventRow[];
            const newEventId = eventRows[0].id;

            const batchSize = 100;
            for (let i = 0; i < req.body.cots.length; i += batchSize) {
                const batch = req.body.cots.slice(i, i + batchSize);
                for (const cot of batch) {
                    await config.pg.execute(sql`
                        INSERT INTO replay_cot (event, connection, source, uid, cot_type, recorded_at, sha256, cot_xml)
                        VALUES (${newEventId}, ${cot.connection ?? null}, ${cot.source}, ${cot.uid},
                                ${cot.cot_type ?? null}, ${cot.recorded_at}, ${cot.sha256}, ${cot.cot_xml})
                    `);
                }
            }

            res.json({ event: eventRows[0], imported: req.body.cots.length });
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
