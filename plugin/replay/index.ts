import type { App } from 'vue';
import { markRaw } from 'vue';
import type { PluginAPI, PluginInstance } from '../../plugin.ts';
import type { MenuItemConfig } from '../../plugin.ts';
import { IconPlayerPlay } from '@tabler/icons-vue';
import ReplayPanel from './ReplayPanel.vue';

const MENU_KEY   = 'plugin-replay';
const ROUTE_NAME = 'home-menu-replay';

export default class ReplayPlugin implements PluginInstance {
    api: PluginAPI;

    constructor(api: PluginAPI) {
        this.api = api;
    }

    static async install(app: App, api: PluginAPI): Promise<ReplayPlugin> {
        void app;
        api.routes.add(
            { path: 'replay', name: ROUTE_NAME, component: ReplayPanel },
            'home-menu'
        );
        return new ReplayPlugin(api);
    }

    async enable(): Promise<void> {
        this.api.menu.add({
            key:         MENU_KEY,
            label:       'Replay',
            route:       ROUTE_NAME,
            tooltip:     'CloudTAK Replay',
            description: 'Record and play back CoT traffic for training and after-action review',
            icon:        markRaw(IconPlayerPlay) as unknown as MenuItemConfig['icon'],
        } as MenuItemConfig);
    }

    async disable(): Promise<void> {
        try { this.api.menu.remove(MENU_KEY); } catch { /* ignore */ }
    }
}
