// api/stateless/lib/replay-export.ts
//
// KML and CSV exports of a recorded event, for use outside CloudTAK (Google
// Earth, ArcGIS, ATAK, Excel). The CloudTAK JSON export in routes/replay.ts
// stays the format for importing a recording into another CloudTAK.
//
// Built from the same replay_cot rows playback uses: each 'cot' row is
// parsed with node-cot, 'removed' rows mark when a drawn feature was deleted.

import { CoTParser } from '@tak-ps/node-cot';
import tzlookup from '@photostructure/tz-lookup';
import { stringify } from 'csv-stringify/sync';
import { categorize, extractHow, computeStaleOffsetMs } from './replay-player.js';
import type { ReplayCategory } from './replay-player.js';

export interface ExportRow {
    uid: string;
    cot_type: string | null;
    recorded_at: string | Date;
    cot_xml: string;
    kind: string;
    source: string;
}

export interface ExportEvent {
    name: string;
    started_at: string | Date;
    ended_at: string | Date | null;
}

type Geometry
    = | { type: 'Point'; coordinates: number[] }
        | { type: 'LineString'; coordinates: number[][] }
        | { type: 'Polygon'; coordinates: number[][][] }
        | { type: string; coordinates: unknown };

interface Sample {
    uid: string;
    time: Date;
    kind: 'cot' | 'removed';
    drawn: boolean;
    type: string;
    callsign: string;
    category: ReplayCategory;
    geometry: Geometry | null;
    lon: number | null;
    lat: number | null;
    hae: number | null;
    speed: number | null; // m/s
    course: number | null; // degrees
    staleMs: number;
}

// CoT's "unknown" value for hae/ce/le, and often speed/course
const UNKNOWN = 9999999;

function known(n: unknown): number | null {
    const v = Number(n);
    return n === undefined || n === null || n === '' || !Number.isFinite(v) || v === UNKNOWN ? null : v;
}

/**
 * Parse the event's rows (ordered by recorded_at) into samples. A 'removed'
 * row carries no XML, so it reuses the last known callsign/type/position of
 * its uid. Unparseable rows are skipped.
 */
export async function toSamples(rows: ExportRow[]): Promise<Sample[]> {
    const last = new Map<string, Sample>();
    const samples: Sample[] = [];

    for (const row of rows) {
        const time = new Date(row.recorded_at);
        // 'authored' rows also include the start-of-recording snapshot of
        // live assets; only <archive/> marks a user's own drawn feature.
        const drawn = row.source === 'authored' && /<archive\b/.test(row.cot_xml);

        if (row.kind === 'removed') {
            const prev = last.get(row.uid);
            samples.push({
                uid: row.uid, time, kind: 'removed', drawn: prev?.drawn ?? row.source === 'authored',
                type: prev?.type ?? '', callsign: prev?.callsign ?? '', category: prev?.category ?? 'other',
                geometry: null, lon: prev?.lon ?? null, lat: prev?.lat ?? null, hae: null,
                speed: null, course: null, staleMs: 0,
            });
            continue;
        }

        try {
            const feat = await CoTParser.to_geojson(await CoTParser.from_xml(row.cot_xml));
            const props = feat.properties as Record<string, unknown>;
            const center = Array.isArray(props.center) ? props.center as number[] : [];
            // 0,0 is a client with no position fix, not a real location
            const fixed = !(Number(center[0]) === 0 && Number(center[1]) === 0);
            const type = String(props.type || row.cot_type || '');

            const sample: Sample = {
                uid: row.uid, time, kind: 'cot', drawn,
                type,
                callsign: String(props.callsign || row.uid),
                category: categorize(type, extractHow(row.cot_xml)),
                geometry: fixed ? feat.geometry as Geometry : null,
                lon: fixed ? known(center[0]) : null,
                lat: fixed ? known(center[1]) : null,
                hae: known(center[2]),
                speed: known(props.speed),
                course: known(props.course),
                staleMs: computeStaleOffsetMs(row.cot_xml),
            };
            last.set(row.uid, sample);
            samples.push(sample);
        } catch (err) {
            console.error(`[replay] export skipping unparseable row for uid ${row.uid}:`, err);
        }
    }

    return samples;
}

// --- CSV ---------------------------------------------------------------

const localFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Local time where the position was recorded, e.g. "2026-10-24 13:52:25"
 * in America/Chicago. Blank if there's no position or no time zone there.
 */
export function localTime(time: Date, lat: number | null, lon: number | null): { local: string; zone: string } {
    if (lat === null || lon === null) return { local: '', zone: '' };

    let zone: string;
    try {
        zone = tzlookup(lat, lon);
    } catch {
        return { local: '', zone: '' };
    }
    if (!zone) return { local: '', zone: '' };

    let fmt = localFormatters.get(zone);
    if (!fmt) {
        // sv-SE formats as YYYY-MM-DD HH:mm:ss
        fmt = new Intl.DateTimeFormat('sv-SE', {
            timeZone: zone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        });
        localFormatters.set(zone, fmt);
    }

    return { local: fmt.format(time), zone };
}

function round(n: number | null, places: number): string {
    return n === null ? '' : String(Math.round(n * 10 ** places) / 10 ** places);
}

export const CSV_COLUMNS = [
    'time_utc', 'time_local', 'time_zone', 'callsign', 'uid', 'type', 'category',
    'lat', 'lon', 'altitude_m', 'altitude_ft', 'speed_mph', 'speed_kts', 'course_deg',
    'source', 'event',
];

/** One row per recorded update or removal, in time order. */
export function buildCsv(samples: Sample[]): string {
    const records = samples.map((s) => {
        const { local, zone } = localTime(s.time, s.lat, s.lon);
        return [
            s.time.toISOString(),
            local,
            zone,
            s.callsign,
            s.uid,
            s.type,
            s.drawn ? 'drawn' : s.category,
            round(s.lat, 6),
            round(s.lon, 6),
            round(s.hae, 1),
            round(s.hae === null ? null : s.hae * 3.28084, 1),
            round(s.speed === null ? null : s.speed * 2.236936, 1),
            round(s.speed === null ? null : s.speed * 1.943844, 1),
            round(s.course, 0),
            s.drawn ? 'drawn' : 'live',
            s.kind === 'removed' ? 'removed' : 'update',
        ];
    });

    return stringify([CSV_COLUMNS, ...records]);
}

// --- KML ---------------------------------------------------------------

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// KML colours are aabbggrr
const STYLES: Record<string, string> = {
    friendly: 'ffff8000',
    hostile: 'ff0000ff',
    neutral: 'ff00c000',
    unknown: 'ff00ffff',
    drawn: 'ff0080ff',
    other: 'ffffffff',
};

function styleFor(s: Sample): string {
    if (s.drawn) return 'drawn';
    if (!s.type.startsWith('a-')) return 'other';
    switch (s.type.split('-')[1]) {
        case 'f': case 'a': return 'friendly';
        case 'h': case 's': case 'j': case 'k': return 'hostile';
        case 'n': return 'neutral';
        case 'u': case 'p': return 'unknown';
        default: return 'other';
    }
}

function styleXml(id: string, color: string): string {
    return `<Style id="${id}">`
        + `<IconStyle><color>${color}</color><scale>0.9</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle>`
        + `<LineStyle><color>${color}</color><width>2</width></LineStyle>`
        + `<PolyStyle><color>${'66' + color.slice(2)}</color></PolyStyle>`
        + '</Style>';
}

function coord(c: number[]): string {
    return `${c[0]},${c[1]}${c.length > 2 && known(c[2]) !== null ? ',' + c[2] : ''}`;
}

function geometryXml(g: Geometry | null): string {
    if (!g) return '';
    if (g.type === 'Point') return `<Point><coordinates>${coord(g.coordinates as number[])}</coordinates></Point>`;
    if (g.type === 'LineString') {
        return `<LineString><tessellate>1</tessellate><coordinates>${(g.coordinates as number[][]).map(coord).join(' ')}</coordinates></LineString>`;
    }
    if (g.type === 'Polygon') {
        const [outer, ...inner] = g.coordinates as number[][][];
        return '<Polygon><tessellate>1</tessellate>'
            + `<outerBoundaryIs><LinearRing><coordinates>${outer.map(coord).join(' ')}</coordinates></LinearRing></outerBoundaryIs>`
            + inner.map(ring => `<innerBoundaryIs><LinearRing><coordinates>${ring.map(coord).join(' ')}</coordinates></LinearRing></innerBoundaryIs>`).join('')
            + '</Polygon>';
    }
    return '';
}

function describe(s: Sample): string {
    const lines = [`Type: ${s.type}`, `UID: ${s.uid}`];
    if (s.hae !== null) lines.push(`Altitude (HAE): ${round(s.hae * 3.28084, 0)} ft / ${round(s.hae, 0)} m`);
    if (s.speed !== null) lines.push(`Speed: ${round(s.speed * 2.236936, 1)} mph / ${round(s.speed * 1.943844, 1)} kts`);
    if (s.course !== null) lines.push(`Course: ${round(s.course, 0)}°`);
    return `<description>${esc(lines.join('\n'))}</description>`;
}

function span(begin: Date, end: Date): string {
    return `<TimeSpan><begin>${begin.toISOString()}</begin><end>${end.toISOString()}</end></TimeSpan>`;
}

const FOLDERS: Array<[string, string]> = [
    ['aircraft', 'Aircraft'], ['uas', 'UAS'], ['ground', 'Ground'],
    ['maritime', 'Maritime'], ['other', 'Other'], ['drawn', 'Drawn features'],
];

/**
 * KML document for the event. Moving assets (a-* points) become gx:Track
 * placemarks so Google Earth's time slider plays them and draws their path;
 * everything else (drawn shapes, markers, other CoT) becomes one placemark
 * per recorded version with a TimeSpan from that version until the next one,
 * its removal, the end of its stale window, or the end of the recording.
 */
export function buildKml(event: ExportEvent, samples: Sample[]): string {
    const lastTime = samples.length ? samples[samples.length - 1].time : new Date(event.started_at);
    const eventEnd = event.ended_at ? new Date(event.ended_at) : lastTime;

    const byUid = new Map<string, Sample[]>();
    for (const s of samples) {
        const list = byUid.get(s.uid);
        if (list) list.push(s);
        else byUid.set(s.uid, [s]);
    }

    const folders = new Map<string, string[]>(FOLDERS.map(([key]) => [key, []]));

    for (const list of byUid.values()) {
        const cots = list.filter(s => s.kind === 'cot' && s.geometry);
        if (!cots.length) continue;

        const latest = cots[cots.length - 1];
        const folder = latest.drawn ? 'drawn' : latest.category;
        const style = styleFor(latest);
        const removed = list.find(s => s.kind === 'removed' && s.time >= latest.time);
        const end = new Date(Math.min(
            removed ? removed.time.getTime() : latest.time.getTime() + latest.staleMs,
            eventEnd.getTime(),
        ));
        const tracked = !latest.drawn && latest.type.startsWith('a-') && cots.every(s => s.geometry?.type === 'Point');

        if (tracked && cots.length > 1) {
            const altitudeMode = latest.category === 'aircraft' || latest.category === 'uas' ? 'absolute' : 'clampToGround';
            folders.get(folder)!.push(
                `<Placemark><name>${esc(latest.callsign)}</name>${describe(latest)}<styleUrl>#${style}</styleUrl>`
                + `<gx:Track><altitudeMode>${altitudeMode}</altitudeMode>`
                + cots.map(s => `<when>${s.time.toISOString()}</when>`).join('')
                + cots.map(s => `<gx:coord>${s.lon} ${s.lat} ${s.hae ?? 0}</gx:coord>`).join('')
                + '</gx:Track></Placemark>',
            );
            continue;
        }

        cots.forEach((s, i) => {
            const until = i + 1 < cots.length ? cots[i + 1].time : end;
            const geometry = geometryXml(s.geometry);
            if (!geometry) return;
            folders.get(folder)!.push(
                `<Placemark><name>${esc(s.callsign)}</name>${describe(s)}<styleUrl>#${style}</styleUrl>`
                + span(s.time, until < s.time ? s.time : until)
                + geometry + '</Placemark>',
            );
        });
    }

    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>'
        + `<name>${esc(event.name)}</name>`
        + `<description>${esc(`Recorded ${new Date(event.started_at).toISOString()} to ${eventEnd.toISOString()}`)}</description>`
        + Object.entries(STYLES).map(([id, color]) => styleXml(id, color)).join('')
        + FOLDERS
            .filter(([key]) => folders.get(key)!.length)
            .map(([key, name]) => `<Folder><name>${name}</name>${folders.get(key)!.join('')}</Folder>`)
            .join('')
            + '</Document></kml>\n';
}
