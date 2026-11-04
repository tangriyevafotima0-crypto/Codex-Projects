import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { it } from 'node:test';

it('actual worker entrypoint stays alive while idle and handles an OS SIGTERM', { timeout: 7000 }, async () => {
  const child = spawn(process.execPath, [require.resolve('../src/main')], { env: {
    ...process.env, NODE_ENV: 'test', WORKER_ID: 'worker-subprocess',
    CENTER_ID: '11111111-2222-4333-8444-555555555555', CENTER_SLUG: 'test-center',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test', CENTER_TIMEZONE: 'Asia/Tashkent',
    WORKER_POLL_INTERVAL_MS: '100', WORKER_SHUTDOWN_TIMEOUT_MS: '1000', BOT_OUTBOUND_ENABLED: 'false',
  } });
  let output = ''; child.stdout.on('data', (b: Buffer) => { output += b.toString(); });
  const closed = once(child, 'close');
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, output);
    assert.match(output, /worker_started/);
    child.kill('SIGTERM'); await closed;
    assert.equal(child.exitCode, 0); assert.match(output, /worker_stopped_gracefully/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
  }
});
