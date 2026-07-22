<!-- api/web/plugins/replay/RecordingBanner.vue -->
<template>
    <div
        v-if='recordingState.active'
        class='badge bg-danger d-flex align-items-center gap-1 py-2 px-3'
    >
        <span>&#9679;</span>
        <span>RECORDING: {{ recordingState.eventName }}</span>
    </div>
</template>

<script setup lang="ts">
import { recordingState } from './replay-state.ts';
</script>
