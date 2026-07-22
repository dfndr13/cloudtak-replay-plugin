<!-- api/web/plugins/replay/ReplayPanel.vue -->
<template>
    <div class='replay-panel p-2'>
        <!-- Recording ---------------------------------------------------- -->
        <div class='mb-3 border-bottom pb-2'>
            <div v-if='!recording.active'>
                <label class='form-label small'>Event name</label>
                <div class='d-flex gap-2'>
                    <input
                        v-model='newEventName'
                        class='form-control form-control-sm'
                        placeholder='e.g. KSF 2026'
                    >
                    <button
                        class='btn btn-sm btn-danger'
                        :disabled='!newEventName'
                        @click='startRecording'
                    >
                        Record
                    </button>
                </div>
            </div>
            <div
                v-else
                class='d-flex align-items-center justify-content-between'
            >
                <span class='text-danger'>&#9679; Recording: {{ recording.event?.name }}</span>
                <button
                    class='btn btn-sm btn-outline-danger'
                    @click='stopRecording'
                >
                    Stop
                </button>
            </div>
        </div>

        <!-- Event picker --------------------------------------------------- -->
        <div
            v-if='!session'
            class='mb-3'
        >
            <label class='form-label small'>Recorded events</label>
            <select
                v-model='selectedEventId'
                class='form-select form-select-sm'
            >
                <option
                    v-for='e in events'
                    :key='e.id'
                    :value='e.id'
                >
                    {{ e.name }} ({{ new Date(e.started_at).toLocaleString() }})
                </option>
            </select>
            <button
                class='btn btn-sm btn-primary mt-2 w-100'
                :disabled='!selectedEventId'
                @click='startPlayback'
            >
                Start Playback
            </button>

            <div class='d-flex gap-2 mt-2'>
                <button
                    class='btn btn-sm btn-outline-secondary flex-fill'
                    :disabled='!selectedEventId'
                    @click='exportEvent'
                >
                    Export
                </button>
                <label class='btn btn-sm btn-outline-secondary flex-fill mb-0'>
                    Import
                    <input
                        type='file'
                        accept='.json'
                        class='d-none'
                        @change='importEvent'
                    >
                </label>
                <button
                    class='btn btn-sm btn-outline-danger flex-fill'
                    :disabled='!selectedEventId'
                    @click='deleteEvent'
                >
                    Delete
                </button>
            </div>
        </div>

        <!-- Playback controls ----------------------------------------------- -->
        <div v-else>
            <div class='alert alert-danger py-1 px-2 mb-2 text-center small fw-bold'>
                {{ activeEventName }} Playback
            </div>
            <div class='d-flex align-items-center gap-2 mb-2'>
                <button
                    class='btn btn-sm btn-outline-secondary'
                    @click='back'
                >
                    &lt;
                </button>
                <button
                    v-if='!paused'
                    class='btn btn-sm btn-outline-secondary'
                    @click='pause'
                >
                    Pause
                </button>
                <button
                    v-else
                    class='btn btn-sm btn-outline-secondary'
                    @click='resume'
                >
                    Play
                </button>
                <button
                    class='btn btn-sm btn-outline-danger ms-auto'
                    @click='stopPlayback'
                >
                    Stop
                </button>
            </div>

            <input
                v-model.number='progressPercent'
                type='range'
                min='0'
                max='100'
                class='form-range mb-1'
                @change='seekPercent'
            >
            <div class='small text-muted mb-2'>
                {{ progressLabel }}
            </div>

            <div class='d-flex align-items-center gap-2 mb-3'>
                <label class='small mb-0'>Speed</label>
                <select
                    v-model.number='speed'
                    class='form-select form-select-sm w-auto'
                    @change='setSpeed'
                >
                    <option
                        v-for='s in [1,2,5,10,15,30,50]'
                        :key='s'
                        :value='s'
                    >
                        {{ s }}x
                    </option>
                </select>
            </div>

            <div class='mb-2'>
                <label class='form-label small d-block'>Show</label>
                <div
                    v-for='cat in categories'
                    :key='cat'
                    class='form-check form-check-inline'
                >
                    <input
                        :id='`cat-${cat}`'
                        v-model='activeCategories[cat]'
                        class='form-check-input'
                        type='checkbox'
                        @change='toggleCategory(cat)'
                    >
                    <label
                        class='form-check-label small text-capitalize'
                        :for='`cat-${cat}`'
                    >{{ cat }}</label>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { std } from '../../src/std.ts';
import FeatureManager from '../../src/base/feature.ts';
import { FeatureVisibility } from '../../src/stores/modules/feature-visibility.ts';
import ProfileConfig from '../../src/base/profile.ts';
import { useMapStore } from '../../src/stores/map.ts';
import { replayPlaybackState, recordingState } from './replay-state.ts';
import ReplayBanner from './ReplayBanner.vue';
import RecordingBanner from './RecordingBanner.vue';

const mapStore = useMapStore();
const BANNER_KEY = 'replay-playback-banner';
const RECORDING_BANNER_KEY = 'replay-recording-banner';

type Category = 'aircraft' | 'uas' | 'ground' | 'maritime' | 'other';
const categories: Category[] = ['aircraft', 'uas', 'ground', 'maritime', 'other'];

interface ReplayEvent {
    id: number;
    name: string;
    started_at: string;
    ended_at?: string;
    status: string;
}

const events = ref<ReplayEvent[]>([]);
const selectedEventId = ref<number | null>(null);
const activeEventName = ref('');
let hiddenLiveIds: string[] = [];
// The user's own live self-position marker shares its CoT UID with any
// replayed copy of "themselves" in the recording. Its live updates go
// straight to the TAK server (PUT /profile/location -> tak.write), bypassing
// ConnectionPool.cots()'s replay tagging entirely, then echo back tagged
// replay:false - a continuous geolocation watch keeps re-submitting it, so
// it repeatedly wins the race against the replay tag. Simplest fix: never
// let the replay-visibility mechanism touch this UID at all.
let selfUid: string | null = null;

// UIDs confirmed delivered by the *current* playback session. Rebuilt from
// scratch every time a session starts - membership in properties.replay
// alone isn't trustworthy, since that's a persisted per-feature flag that
// survives unchanged on any UID a *previous*, unrelated session touched but
// this one never revisits.
let sessionReplayUids: Set<string> = new Set();
// Baseline of each UID's CoT generation time (properties.time), snapshotted
// at session start and advanced as genuine new arrivals are detected. Used
// to tell "still carrying a stale replay:true flag from a prior session"
// apart from "just got a fresh replay message in this session" - the flag
// alone can't do that, but the CoT's own timestamp only changes when a new
// message actually arrives for that UID.
let lastSeenTime: Map<string, string> = new Map();
const newEventName = ref('');
const recording = reactive<{ active: boolean; event?: { id: number; name: string } }>({ active: false });

const session = ref<string | null>(null);
const paused = ref(false);
const speed = ref(1);
const progressPercent = ref(0);
const progressLabel = ref('');
const activeCategories = reactive<Record<Category, boolean>>({
    aircraft: true, uas: true, ground: true, maritime: true, other: true,
});

let pollHandle: ReturnType<typeof setInterval> | undefined;

async function pollStatus() {
    if (!session.value) return;
    const body = await std(`/api/replay/session/${session.value}/status`) as { active: boolean; paused?: boolean; percent?: number };
    if (!body.active) {
        session.value = null;
        if (pollHandle) clearInterval(pollHandle);
        restoreLiveFeatures();
        hideReplayBanner();
        progressLabel.value = 'Playback finished';
        return;
    }
    paused.value = !!body.paused;
    progressPercent.value = Math.round(body.percent || 0);
    progressLabel.value = `Progress: ${progressPercent.value}%`;
}

onMounted(async () => {
    await refreshEvents();
    await refreshRecordingStatus();
});

onUnmounted(() => {
    if (pollHandle) clearInterval(pollHandle);
    if (session.value) {
        // Null this out (not just clearInterval) so a poll tick that's
        // already mid-flight - past pollStatus(), about to call
        // hideNewLiveFeatures() - bails at the session.value guard below
        // instead of re-hiding everything restoreLiveFeatures() just undid.
        session.value = null;
        restoreLiveFeatures();
        hideReplayBanner();
    }
});

async function refreshEvents() {
    const body = await std('/api/replay/event') as { events: ReplayEvent[] };
    events.value = body.events;
}

async function refreshRecordingStatus() {
    const body = await std('/api/replay/record/status') as { active: boolean; event?: { id: number; name: string } };
    recording.active = body.active;
    recording.event = body.event;
    syncRecordingBanner();
}

async function startRecording() {
    await std('/api/replay/record/start', { method: 'POST', body: { name: newEventName.value } });
    newEventName.value = '';
    await refreshRecordingStatus();
}

async function stopRecording() {
    await std('/api/replay/record/stop', { method: 'POST' });
    await refreshRecordingStatus();
    await refreshEvents();
}

async function resolveSelfUid(): Promise<string | null> {
    const username = await ProfileConfig.get('username');
    return username?.value ? `ANDROID-CloudTAK-${username.value}` : null;
}

async function hideLiveFeatures() {
    selfUid = await resolveSelfUid();
    const live = await FeatureManager.list();
    hiddenLiveIds = live.map((f) => f.id).filter((id) => id !== selfUid);
    if (hiddenLiveIds.length) FeatureVisibility.setFeaturesHidden(hiddenLiveIds, true);

    // Fresh session: no UID is exempt yet, and every feature's current
    // properties.time becomes the baseline that new arrivals must beat.
    sessionReplayUids = new Set();
    lastSeenTime = new Map(live.map((f) => [f.id, String(f.properties.time || '')]));
}

async function hideNewLiveFeatures() {
    const live = await FeatureManager.list();

    // A feature only belongs to this session once its CoT generation time
    // has actually moved past the baseline - that's proof a new message
    // landed while we were watching, not just a leftover replay:true flag.
    for (const f of live) {
        if (f.properties.replay !== true) continue;
        const time = String(f.properties.time || '');
        if (lastSeenTime.get(f.id) === time) continue;
        lastSeenTime.set(f.id, time);
        sessionReplayUids.add(f.id);
    }

    // Replay-origin features must never be hidden - even if their UID was
    // already hidden as "live" (e.g. hidden at playback start, then updated
    // by the replay itself), unhide it as soon as we confirm it belongs to
    // this session.
    const toUnhide = [...sessionReplayUids].filter((id) => hiddenLiveIds.includes(id));
    if (toUnhide.length) {
        FeatureVisibility.setFeaturesHidden(toUnhide, false);
        hiddenLiveIds = hiddenLiveIds.filter((id) => !toUnhide.includes(id));
    }

    const newIds = live
        .map((f) => f.id)
        .filter((id) => id !== selfUid && !hiddenLiveIds.includes(id) && !sessionReplayUids.has(id));
    if (newIds.length) {
        FeatureVisibility.setFeaturesHidden(newIds, true);
        hiddenLiveIds.push(...newIds);
    }
}

function restoreLiveFeatures() {
    if (hiddenLiveIds.length) FeatureVisibility.setFeaturesHidden(hiddenLiveIds, false);
    hiddenLiveIds = [];
    sessionReplayUids = new Set();
    lastSeenTime = new Map();
}

function showReplayBanner(name: string) {
    replayPlaybackState.active = true;
    replayPlaybackState.eventName = name;
    try {
        mapStore.bottomBar.addItem({ key: BANNER_KEY, component: ReplayBanner });
    } catch (err) {
        console.warn('Failed to add replay banner, map not loaded?', err);
    }
}

function hideReplayBanner() {
    replayPlaybackState.active = false;
    try {
        mapStore.bottomBar.removeItem(BANNER_KEY);
    } catch {
        // Ignore error if bottomBar is not loaded
    }
}

// Recording runs server-side regardless of whether this panel is mounted,
// so - unlike the playback banner - this is only ever synced from
// refreshRecordingStatus(), never added/removed from onUnmounted().
function syncRecordingBanner() {
    if (recording.active && recording.event) {
        recordingState.active = true;
        recordingState.eventName = recording.event.name;
        try {
            mapStore.bottomBar.addItem({ key: RECORDING_BANNER_KEY, component: RecordingBanner });
        } catch (err) {
            console.warn('Failed to add recording banner, map not loaded?', err);
        }
    } else {
        recordingState.active = false;
        try {
            mapStore.bottomBar.removeItem(RECORDING_BANNER_KEY);
        } catch {
            // Ignore error if bottomBar is not loaded
        }
    }

    // The Atlas worker runs in its own Web Worker realm and can't read the
    // recordingState singleton above directly (it's re-instantiated
    // per-realm), so push the flag across explicitly - this is what
    // AtlasDatabase.add() actually checks before direct-writing a drawn
    // feature into the active recording. Comlink calls are async, so a
    // sync try/catch wouldn't see a rejection - use .catch() instead.
    try {
        mapStore.worker.db.setRecordingActive(recording.active)
            .catch((err: unknown) => console.warn('Failed to sync recording state to worker', err));
    } catch (err) {
        console.warn('Failed to sync recording state to worker, map not loaded?', err);
    }
}

async function startPlayback() {
    if (!selectedEventId.value) return;
    const evt = events.value.find((e) => e.id === selectedEventId.value);
    activeEventName.value = evt ? evt.name : 'Replay';

    await hideLiveFeatures();
    showReplayBanner(activeEventName.value);

    const body = await std(`/api/replay/event/${selectedEventId.value}/play`, {
        method: 'POST',
        body: { speed: speed.value },
    }) as { sessionId: string };
    session.value = body.sessionId;
    paused.value = false;
    progressPercent.value = 0;
    progressLabel.value = 'Starting...';
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(async () => {
        await pollStatus();
        // pollStatus() may have just ended the session (natural finish) and
        // called restoreLiveFeatures(), which resets sessionReplayUids to
        // empty. Calling hideNewLiveFeatures() right after would see no
        // exemptions and immediately re-hide everything it just restored.
        if (!session.value) return;
        await hideNewLiveFeatures();
    }, 1000);
}

async function pause() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/pause`, { method: 'POST' });
    paused.value = true;
}

async function resume() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/resume`, { method: 'POST' });
    paused.value = false;
}

async function back() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/back`, { method: 'POST', body: { wallSeconds: 30 } });
    paused.value = true;
}

async function seekPercent() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/seek`, {
        method: 'POST',
        body: { percent: progressPercent.value },
    });
    paused.value = true;
}

async function setSpeed() {
}

async function toggleCategory(cat: Category) {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/category`, {
        method: 'POST',
        body: { category: cat, on: activeCategories[cat] },
    });
}

async function stopPlayback() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/stop`, { method: 'POST' });
    session.value = null;
    if (pollHandle) clearInterval(pollHandle);
    restoreLiveFeatures();
    hideReplayBanner();
}

async function exportEvent() {
    if (!selectedEventId.value) return;
    await std(`/api/replay/event/${selectedEventId.value}/export`, { download: true });
}

async function deleteEvent() {
    if (!selectedEventId.value) return;
    const evt = events.value.find((e) => e.id === selectedEventId.value);
    const name = evt ? evt.name : `event ${selectedEventId.value}`;
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

    await std(`/api/replay/event/${selectedEventId.value}`, { method: 'DELETE' });
    selectedEventId.value = null;
    await refreshEvents();
}

async function importEvent(evt: Event) {
    const input = evt.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const text = await file.text();
    const parsed = JSON.parse(text);

    await std('/api/replay/import', { method: 'POST', body: parsed });
    await refreshEvents();
    input.value = '';
}
</script>
