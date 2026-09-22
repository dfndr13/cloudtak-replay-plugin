import test from 'node:test';
import assert from 'node:assert';
import { sql } from 'drizzle-orm';
import Flight from './flight.js';

const flight = new Flight();

flight.init({ takserver: true });
flight.takeoff();
flight.user();
flight.connection();

const stale = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
const fresh = new Date().toISOString();

test('Setup - seed stale and fresh replay events', async () => {
    try {
        const config = flight.config;
        if (!config) throw new Error('Flight config not initialized');

        const [staleEvent] = await config.pg.execute(sql`
            INSERT INTO replay_events (name, started_at, status, username)
            VALUES ('Stale Event', ${stale}::timestamptz, 'stopped', 'admin')
            RETURNING id
        `) as unknown as { id: number }[];

        const [freshEvent] = await config.pg.execute(sql`
            INSERT INTO replay_events (name, started_at, status, username)
            VALUES ('Fresh Event', ${fresh}::timestamptz, 'stopped', 'admin')
            RETURNING id
        `) as unknown as { id: number }[];

        await config.pg.execute(sql`
            INSERT INTO replay_cot (event, uid, sha256, cot_xml)
            VALUES (${staleEvent.id}, 'stale-uid', 'deadbeef', '<event/>')
        `);
        await config.pg.execute(sql`
            INSERT INTO replay_cot (event, uid, sha256, cot_xml)
            VALUES (${freshEvent.id}, 'fresh-uid', 'deadbeef', '<event/>')
        `);
    } catch (err) {
        assert.ifError(err);
    }
});

test('POST api/retention - replay action deletes only stale events and cascades to replay_cot', async () => {
    try {
        const res = await flight.fetch('/api/retention', {
            method: 'POST',
            auth: {
                bearer: flight.token.admin,
            },
            body: {
                action: 'replay',
            },
        }, true);

        assert.equal(res.body.name, 'replay');
        assert.equal(res.body.status, 'success');
        assert.equal(res.body.deleted, 1);
        assert.equal(typeof res.body.duration, 'number');

        const config = flight.config;
        if (!config) throw new Error('Flight config not initialized');

        const remainingEvents = await config.pg.execute(sql`
            SELECT name FROM replay_events
        `) as unknown as { name: string }[];
        assert.deepEqual(remainingEvents.map(row => row.name), ['Fresh Event']);

        const remainingCot = await config.pg.execute(sql`
            SELECT uid FROM replay_cot
        `) as unknown as { uid: string }[];
        assert.deepEqual(remainingCot.map(row => row.uid), ['fresh-uid']);
    } catch (err) {
        assert.ifError(err);
    }
});

flight.landing();
