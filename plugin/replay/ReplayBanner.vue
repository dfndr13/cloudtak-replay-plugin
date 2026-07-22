<!-- api/web/plugins/replay/ReplayBanner.vue -->
<template>
    <div
        v-if='replayPlaybackState.active'
        class='badge bg-danger d-flex align-items-center gap-1 py-2 px-3'
    >
        <span>&#9679;</span>
        <span>REPLAY: {{ replayPlaybackState.eventName }}</span>
    </div>
</template>

<script setup lang="ts">
import { replayPlaybackState } from './replay-state.ts';
</script>
