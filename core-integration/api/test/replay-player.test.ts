import test from 'node:test';
import assert from 'node:assert';
import { toReplayXml, replayUid } from '../stateless/lib/replay-player.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function cot(detail: string): string {
    return '<event version="2.0" uid="MPD-1" type="a-f-G-U-C" how="m-g" time="2026-01-01T00:00:00Z" start="2026-01-01T00:00:00Z" stale="2026-01-01T00:05:00Z">'
        + '<point lat="39.05" lon="-96.5" hae="0" ce="9999999" le="9999999"/>'
        + `<detail>${detail}</detail></event>`;
}

test('toReplayXml - moves the event to its replay uid', () => {
    const xml = toReplayXml(cot('<contact callsign="MPD 1"/>'), new Set(['MPD-1']), NOW);
    assert.match(xml, /<event version="2.0" uid="replay-MPD-1"/);
    assert.equal(replayUid('MPD-1'), 'replay-MPD-1');
});

test('toReplayXml - marks the callsign as a replay', () => {
    const xml = toReplayXml(cot('<contact endpoint="*:-1:stcp" callsign="MPD 1"/>'), new Set(['MPD-1']), NOW);
    assert.match(xml, /callsign="MPD 1 \(replay\)"/);
});

test('toReplayXml - fresh timestamps with a long stale', () => {
    const xml = toReplayXml(cot(''), new Set(['MPD-1']), NOW);
    assert.match(xml, / time="2026-06-01T12:00:00.000Z"/);
    assert.match(xml, / start="2026-06-01T12:00:00.000Z"/);
    assert.match(xml, / stale="2026-06-02T12:00:00.000Z"/);
});

test('toReplayXml - removes <archive/> so the copy is never saved', () => {
    assert.doesNotMatch(toReplayXml(cot('<archive/><contact callsign="MPD 1"/>'), new Set(['MPD-1']), NOW), /archive/);
    assert.doesNotMatch(toReplayXml(cot('<archive></archive>'), new Set(['MPD-1']), NOW), /archive/);
});

test('toReplayXml - remaps links to recorded uids only', () => {
    const detail = '<link uid="MPD-2" relation="p-p" type="a-f-G-U-C"/><link uid="ANDROID-xyz" relation="p-p" type="a-f-G"/>';
    const xml = toReplayXml(cot(detail), new Set(['MPD-1', 'MPD-2']), NOW);
    assert.match(xml, /<link uid="replay-MPD-2"/);
    assert.match(xml, /<link uid="ANDROID-xyz"/);
});
