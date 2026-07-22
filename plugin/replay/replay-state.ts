// api/web/plugins/replay/replay-state.ts
//
// The playback banner (ReplayBanner.vue) is rendered by BottomBarManager,
// detached from ReplayPanel.vue's component tree, so it has no way to
// receive props directly - this shared reactive singleton is how the two
// stay in sync.

import { reactive } from 'vue';

export const replayPlaybackState = reactive<{ active: boolean; eventName: string }>({
    active: false,
    eventName: '',
});

// Recording runs server-side (Recorder.activeEvent), independent of whether
// ReplayPanel.vue is mounted - closing the panel does not stop it. This
// banner is kept in sync from refreshRecordingStatus() so it stays visible
// across panel open/close, not just start/stop clicks.
export const recordingState = reactive<{ active: boolean; eventName: string }>({
    active: false,
    eventName: '',
});
