import { sql } from 'drizzle-orm';

import type ConfigStateless from '../../config.js';
import type { RetentionTask, RetentionTaskResult } from '../retention.js';

const task: RetentionTask = {
    name: 'replay',
    run: async (config: ConfigStateless): Promise<RetentionTaskResult> => {
        const start = Date.now();

        const days = (await config.models.Setting.typed('retention::replay::days')).value || 10;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // replay_cot rows cascade via FK ON DELETE CASCADE (see
        // api/common/replay-schema.ts) - no exemption for exported events,
        // export is the user's own mechanism for preserving data past the window.
        const deleted = await config.pg.execute(sql`
            DELETE FROM replay_events WHERE started_at < ${cutoff.toISOString()}::timestamptz
            RETURNING id
        `) as unknown as { id: number }[];

        console.log(`ok - [replay retention] deleted ${deleted.length} event(s) older than ${days}d (cutoff ${cutoff.toISOString()}), ids=[${deleted.map(row => row.id).join(', ')}]`);

        return {
            name: task.name,
            status: 'success',
            deleted: deleted.length,
            duration: Date.now() - start,
            message: deleted.length ? undefined : 'No expired replay events found',
        };
    },
};

export default task;
