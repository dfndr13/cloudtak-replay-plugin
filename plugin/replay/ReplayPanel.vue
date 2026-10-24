<!-- app/plugins/replay/ReplayPanel.vue -->
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
                        placeholder='Event name'
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
            <button
                v-if='hasReplayFeatures'
                class='btn btn-sm btn-outline-secondary mt-2 w-100'
                @click='clearReplayFeatures'
            >
                Clear replay
            </button>

            <div class='d-flex gap-2 mt-2'>
                <select
                    v-model='exportFormat'
                    class='form-select form-select-sm'
                    :disabled='!selectedEventId'
                >
                    <option value='kml'>
                        KML (Google Earth, ArcGIS, ATAK)
                    </option>
                    <option value='csv'>
                        CSV (Excel, reports)
                    </option>
                    <option value='json'>
                        CloudTAK file (for Import)
                    </option>
                </select>
                <button
                    class='btn btn-sm btn-outline-primary'
                    :disabled='!selectedEventId'
                    @click='exportEvent'
                >
                    Download
                </button>
            </div>

            <div class='d-flex gap-2 mt-2'>
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
import { db } from '../../src/database.ts';
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
// Never hide the user's own position marker during playback.
let selfUid: string | null = null;

// The player sends replayed CoTs under their own UIDs (replay-player.ts
// REPLAY_PREFIX), so replay and live copies of the same asset never share a
// map feature: anything without the prefix is live and hidden during
// playback; replayed copies stay on the map after Stop until cleared.
const REPLAY_PREFIX = 'replay-';
const hasReplayFeatures = ref(false);

function isReplayCopy(id: string): boolean {
    return id.startsWith(REPLAY_PREFIX);
}
const exportFormat = ref<'kml' | 'csv' | 'json'>('kml');
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
    // Replayed copies from an earlier playback survive a page reload
    hasReplayFeatures.value = (await FeatureManager.list()).some((f) => isReplayCopy(f.id));
});

onUnmounted(() => {
    if (pollHandle) clearInterval(pollHandle);
    if (session.value) {
        // Tell the server this session is done, same as stopPlayback() -
        // otherwise it sits idle server-side until SESSION_IDLE_TIMEOUT_MS
        // reaps it. Fire-and-forget: the component is already tearing down,
        // there's nothing left here to await the response for.
        std(`/api/replay/session/${session.value}/stop`, { method: 'POST' }).catch(() => {
            // Best-effort - the idle-timeout reaper on the server is the
            // backstop if this never lands.
        });
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

    // The server is already recording at this point (the POST above
    // succeeded) - snapshot everything currently on the map now, so
    // pre-existing features have an initial row in this recording instead
    // of only ever being captured if something happens to update them
    // during the window.
    try {
        await mapStore.worker.db.snapshotForRecording();
    } catch (err) {
        console.warn('Failed to snapshot pre-existing features into new recording:', err);
    }
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

// FeatureManager.list() only covers the plain (non-Mission) feature table.
// Mission-linked content (anything drawn/shared into an active Mission, or
// synced from one) lives in its own subscription_feature table instead - see
// atlas-database.ts's add(), which stores it there with skipSave: true so it
// never reaches the plain table at all. Without merging both in, replay's
// hide/show sweep is structurally blind to Mission content: it never gets
// hidden at playback start and never gets confirmed as belonging to the
// session, so it just sits visible throughout regardless of replay state.
async function listAllLive() {
    const [features, missionFeatures] = await Promise.all([
        FeatureManager.list(),
        db.subscription_feature.toCollection().toArray(),
    ]);
    return [...features, ...missionFeatures];
}

async function hideLiveFeatures() {
    selfUid = await resolveSelfUid();
    const live = await listAllLive();

    // FeatureVisibility is a single flat store shared with the rest of the
    // app (e.g. Mission Layers' own hide/show toggle) - it has no concept of
    // *why* a feature is hidden. hiddenLiveIds must only ever contain UIDs
    // replay itself is responsible for hiding, or restoreLiveFeatures() will
    // blindly unhide anything that happened to already be hidden for an
    // unrelated reason (e.g. a Mission Layer the user had toggled off)
    // when playback started.
    hiddenLiveIds = live
        .map((f) => f.id)
        .filter((id) => !isReplayCopy(id) && id !== selfUid && !FeatureVisibility.isFeatureHidden(id));
    if (hiddenLiveIds.length) FeatureVisibility.setFeaturesHidden(hiddenLiveIds, true);
}

async function hideNewLiveFeatures() {
    const live = await listAllLive();

    // Same rule as hideLiveFeatures(): only track UIDs replay is newly
    // hiding here, so a feature already hidden for an unrelated reason
    // never ends up in hiddenLiveIds and never gets force-unhidden by
    // restoreLiveFeatures() at session end.
    const newIds = live
        .map((f) => f.id)
        .filter((id) => !isReplayCopy(id) && id !== selfUid && !hiddenLiveIds.includes(id) && !FeatureVisibility.isFeatureHidden(id));
    if (newIds.length) {
        FeatureVisibility.setFeaturesHidden(newIds, true);
        hiddenLiveIds.push(...newIds);
    }
}

function restoreLiveFeatures() {
    if (hiddenLiveIds.length) FeatureVisibility.setFeaturesHidden(hiddenLiveIds, false);
    hiddenLiveIds = [];
}

async function clearReplayFeatures() {
    const replayed = (await FeatureManager.list()).filter((f) => isReplayCopy(f.id));
    for (const f of replayed) {
        // Replayed copies carry no <archive/>, so this never touches the
        // user's saved features; skipNetwork just makes that explicit.
        await mapStore.worker.db.remove(f.id, { skipNetwork: true })
            .catch((err: unknown) => console.warn(`Failed to clear replayed feature ${f.id}`, err));
    }
    hasReplayFeatures.value = false;
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

    await clearReplayFeatures();
    await hideLiveFeatures();
    hasReplayFeatures.value = true;
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
        // called restoreLiveFeatures(). Calling hideNewLiveFeatures() right
        // after would immediately re-hide everything it just restored.
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
    await std(`/api/replay/event/${selectedEventId.value}/export?format=${exportFormat.value}`, { download: true });
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
