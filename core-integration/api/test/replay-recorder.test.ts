import test from 'node:test';
import assert from 'node:assert';
import Recorder, { contentHash } from '../stateful/lib/replay-recorder.js';
import type Config from '../common/config.js';

function cot(opts: { lat: string; time: string; flow: string }): string {
    return `<event version="2.0" uid="TEST-1" type="a-f-G-U-C" how="m-g" time="${opts.time}" start="${opts.time}" stale="${opts.time}">`
        + `<point lat="${opts.lat}" lon="-96.5" hae="0" ce="9999999" le="9999999"/>`
        + `<detail><contact callsign="MPD 1"/>${opts.flow}</detail></event>`;
}

test('contentHash - ignores time/start/stale', () => {
    assert.equal(
        contentHash(cot({ lat: '39.05', time: '2026-01-01T00:00:00Z', flow: '' })),
        contentHash(cot({ lat: '39.05', time: '2026-01-01T00:00:05Z', flow: '' })),
    );
});

test('contentHash - ignores _flow-tags_ timestamps', () => {
    const flow = (server: string, node: string) => `<_flow-tags_ TAK-Server-abc="${server}"><NodeCoT-14.55.0>${node}</NodeCoT-14.55.0></_flow-tags_>`;

    assert.equal(
        contentHash(cot({ lat: '39.05', time: '2026-01-01T00:00:00Z', flow: flow('2026-01-01T00:00:00Z', '2026-01-01T00:00:00.085Z') })),
        contentHash(cot({ lat: '39.05', time: '2026-01-01T00:00:00Z', flow: flow('2026-01-01T00:00:00Z', '2026-01-01T00:00:00.089Z') })),
    );

    assert.equal(
        contentHash(cot({ lat: '39.05', time: '2026-01-01T00:00:00Z', flow: '<_flow-tags_ TAK-Server-abc="2026-01-01T00:00:00Z"/>' })),
        contentHash(cot({ lat: '39.05', time: '2026-01-01T00:00:00Z', flow: '' })),
    );
});

test('contentHash - a moved position is a new hash', () => {
    assert.notEqual(
        contentHash(cot({ lat: '39.05', time: '2026-01-01T00:00:00Z', flow: '' })),
        contentHash(cot({ lat: '39.06', time: '2026-01-01T00:00:00Z', flow: '' })),
    );
});

function recorder(): { rec: Recorder; inserts: () => number } {
    let n = 0;
    const execute = async () => {
        n++;
        return [];
    };
    const config = { pg: { execute } } as unknown as Config;
    const rec = new Recorder(config);
    rec.bootstrapped = true;
    rec.activeEvent = { id: 1, name: 'test' };
    return { rec, inserts: () => n };
}

test('recordRemoval - a repeated delete writes one marker', async () => {
    const { rec, inserts } = recorder();
    await rec.recordRemoval('TEST-1');
    await rec.recordRemoval('TEST-1');
    assert.equal(inserts(), 1);
});

test('recordRemoval - delete, re-create, delete writes two markers', async () => {
    const { rec, inserts } = recorder();
    await rec.recordRemoval('TEST-1');
    await rec.recordDirect('TEST-1', 'a-f-G-U-C', cot({ lat: '39.05', time: '2026-01-01T00:00:00Z', flow: '' }));
    await rec.recordRemoval('TEST-1');
    assert.equal(inserts(), 3);
});
