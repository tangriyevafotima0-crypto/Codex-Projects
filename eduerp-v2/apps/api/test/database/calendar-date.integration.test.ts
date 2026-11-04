import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { it } from 'node:test';
import { createEphemeralTestDbEnv } from './harness';

it('calendar DATE stays YYYY-MM-DD through the real API pool under UTC and Asia/Tashkent', async () => {
  const env = await createEphemeralTestDbEnv();
  try {
    for (const timezone of ['UTC', 'Asia/Tashkent']) {
      const child = spawnSync(process.execPath, ['-e', `
        const { DatabaseService } = require('./dist/src/database/database.service');
        const db = new DatabaseService({ databaseUrl: process.env.DATE_PROBE_DATABASE_URL, dbPoolMax: 2, dbConnectTimeoutMs: 3000, centerSlug: 'date-probe' });
        (async () => { try { const r = await db.query("SELECT DATE '2026-11-04' AS calendar_day"); process.stdout.write(JSON.stringify(r.rows[0])); } finally { await db.close(); } })().catch(() => { process.exitCode = 1; });
      `], {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env, TZ: timezone, DATE_PROBE_DATABASE_URL: env.apiRuntimeCenterAUrl },
        encoding: 'utf8', timeout: 15000,
      });
      assert.equal(child.status, 0, `DATE child failed under ${timezone}: ${child.stderr}`);
      assert.deepEqual(JSON.parse(child.stdout), { calendar_day: '2026-11-04' });
    }
  } finally {
    await env.cleanup();
  }
});
