import test from 'node:test';
import assert from 'node:assert';
import { toSamples, buildCsv, buildKml, localTime, CSV_COLUMNS } from '../stateless/lib/replay-export.js';
import type { ExportRow } from '../stateless/lib/replay-export.js';

function point(uid: string, callsign: string, time: string, lat: number, lon: number, extra = ''): string {
    return `<event version="2.0" uid="${uid}" type="a-f-G-U-C" how="m-g" time="${time}" start="${time}" stale="2026-10-24T19:00:00Z">`
        + `<point lat="${lat}" lon="${lon}" hae="275" ce="9999999" le="9999999"/>`
        + `<detail><contact callsign="${callsign}"/><track course="180" speed="10"/>${extra}</detail></event>`;
}

function row(uid: string, time: string, xml: string, kind = 'cot', source = 'gateway'): ExportRow {
    return { uid, cot_type: 'a-f-G-U-C', recorded_at: time, cot_xml: xml, kind, source };
}

const EVENT = { name: 'MPD <drill> & test', started_at: '2026-10-24T18:52:00Z', ended_at: '2026-10-24T18:54:00Z' };

const ROWS: ExportRow[] = [
    row('MPD-1', '2026-10-24T18:52:25Z', point('MPD-1', 'MPD 1', '2026-10-24T18:52:25Z', 39.117, -95.720)),
    row('MPD-1', '2026-10-24T18:52:28Z', point('MPD-1', 'MPD 1', '2026-10-24T18:52:28Z', 39.116, -95.720)),
    row('DRAWN-1', '2026-10-24T18:52:39Z', point('DRAWN-1', 'apples', '2026-10-24T18:52:39Z', 39.10, -95.70, '<archive/>'), 'cot', 'authored'),
    row('DRAWN-1', '2026-10-24T18:52:59Z', '', 'removed', 'authored'),
];

test('localTime - local time where the position was recorded', () => {
    const t = new Date('2026-10-24T18:52:25Z');
    assert.deepEqual(localTime(t, 39.117, -95.720), { local: '2026-10-24 13:52:25', zone: 'America/Chicago' });
    assert.deepEqual(localTime(t, 39.74, -104.99), { local: '2026-10-24 12:52:25', zone: 'America/Denver' });
    assert.deepEqual(localTime(t, null, null), { local: '', zone: '' });
});

test('buildCsv - one row per update or removal, with units and local time', async () => {
    const lines = buildCsv(await toSamples(ROWS)).trim().split('\n');
    assert.equal(lines[0], CSV_COLUMNS.join(','));
    assert.equal(lines.length, 5);
    assert.equal(lines[1], '2026-10-24T18:52:25.000Z,2026-10-24 13:52:25,America/Chicago,MPD 1,MPD-1,a-f-G-U-C,ground,39.117,-95.72,275,902.2,22.4,19.4,180,live,update');
    assert.match(lines[3], /,apples,DRAWN-1,a-f-G-U-C,drawn,.*,drawn,update$/);
    assert.match(lines[4], /,apples,DRAWN-1,a-f-G-U-C,drawn,39\.1,-95\.7,,,,,,drawn,removed$/);
});

test('buildKml - moving asset becomes a timed track', async () => {
    const kml = buildKml(EVENT, await toSamples(ROWS));
    assert.match(kml, /<Folder><name>Ground<\/name><Placemark><name>MPD 1<\/name>/);
    assert.match(kml, /<gx:Track><altitudeMode>clampToGround<\/altitudeMode><when>2026-10-24T18:52:25.000Z<\/when><when>2026-10-24T18:52:28.000Z<\/when>/);
    assert.match(kml, /<gx:coord>-95.72 39.117 275<\/gx:coord>/);
});

test('buildKml - drawn feature shows until it was removed', async () => {
    const kml = buildKml(EVENT, await toSamples(ROWS));
    assert.match(kml, /<Folder><name>Drawn features<\/name><Placemark><name>apples<\/name>[\s\S]*<TimeSpan><begin>2026-10-24T18:52:39.000Z<\/begin><end>2026-10-24T18:52:59.000Z<\/end><\/TimeSpan><Point>/);
});

test('buildKml - escapes names', async () => {
    const kml = buildKml(EVENT, await toSamples(ROWS));
    assert.match(kml, /<name>MPD &lt;drill&gt; &amp; test<\/name>/);
});

test('toSamples - 0,0 is no position, and only <archive/> rows are drawn', async () => {
    const samples = await toSamples([
        row('ANDROID-x', '2026-10-24T18:52:25Z', point('ANDROID-x', 'me', '2026-10-24T18:52:25Z', 0, 0)),
        row('MPD-2', '2026-10-24T18:52:25Z', point('MPD-2', 'MPD 2', '2026-10-24T18:52:25Z', 39.1, -95.7), 'cot', 'authored'),
    ]);
    assert.equal(samples[0].lat, null);
    assert.equal(samples[0].geometry, null);
    assert.equal(samples[1].drawn, false);

    const csv = buildCsv(samples).trim().split('\n');
    assert.match(csv[1], /^2026-10-24T18:52:25.000Z,,,me,ANDROID-x,/);
    assert.doesNotMatch(buildKml(EVENT, samples), /<name>me<\/name>/);
});
