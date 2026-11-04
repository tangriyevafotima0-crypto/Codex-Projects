import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { it } from 'node:test';

function envFixture(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', API_HOST: '127.0.0.1' };
  const lines = readFileSync(path.resolve(__dirname, '../../../../.env.example'), 'utf8').split('\n');
  for (const line of lines) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const pos = line.indexOf('=');
    env[line.slice(0, pos)] = line.slice(pos + 1).trim();
  }
  env.NODE_ENV = 'test'; env.API_HOST = '127.0.0.1';
  return env;
}

it('boots the actual compiled Nest entrypoint, correlates request ID, and stops on SIGTERM', { timeout: 10000 }, async () => {
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const addr = reserve.address(); assert.ok(addr && typeof addr !== 'string');
  const port = addr.port; await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const child = spawn(process.execPath, [require.resolve('../src/main')], { env: { ...envFixture(), API_PORT: String(port) } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
  const closed = once(child, 'close');
  try {
    const deadline = Date.now() + 5000;
    while (!stdout.includes('api_started')) {
      assert.equal(child.exitCode, null, `API exited before ready: ${stderr}`);
      assert.ok(Date.now() < deadline, `API readiness timed out: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const result = await new Promise<{ status: number; requestId: string | string[] | undefined; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/api/v1/health', headers: { 'X-Request-Id': 'bootstrap-real-nest' } }, (res) => {
        let raw = ''; res.on('data', (b: Buffer) => { raw += b.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, requestId: res.headers['x-request-id'], body: JSON.parse(raw) as Record<string, unknown> }));
      }); req.on('error', reject); req.end();
    });
    assert.equal(result.status, 200); assert.equal(result.requestId, 'bootstrap-real-nest');
    assert.equal(result.body.request_id, result.requestId);
  } finally {
    child.kill('SIGTERM'); await closed;
  }
  assert.ok(child.exitCode === 0 || child.signalCode === 'SIGTERM', stderr);
  assert.equal((stdout.match(/"event":"http_request"/g) ?? []).length, 1);
});

it('actual entrypoint exits nonzero on invalid config without logging raw secret values', { timeout: 5000 }, async () => {
  const env = envFixture(); env.DATABASE_URL = ''; env.JWT_ACCESS_SECRET = 'SECRET_MUST_NOT_APPEAR';
  const child = spawn(process.execPath, [require.resolve('../src/main')], { env });
  let output = ''; child.stdout.on('data', (b: Buffer) => { output += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { output += b.toString(); });
  await once(child, 'close');
  assert.equal(child.exitCode, 1); assert.match(output, /api_startup_failed/);
  assert.equal(output.includes('SECRET_MUST_NOT_APPEAR'), false);
});
