import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { loadApiEnv } from '../src/config/env';
import { RequestLogEntry } from '../src/common/request-id.middleware';
import { createApiApplication } from '../src/application';

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  CENTER_ID: '11111111-2222-4333-8444-555555555555',
  CENTER_SLUG: 'guliston-ilm',
  CENTER_TIMEZONE: 'Asia/Tashkent',
  LICENSE_MODE: 'ACTIVE',
  DATABASE_URL: 'postgresql://eduerp_app_dev:SensitiveDbPass_NeverInHealth_42@postgres:5432/eduerp_guliston_ilm_dev',
  JWT_ACCESS_SECRET: 'SensitiveJwtAccessSecret_NeverInHealth_00001',
  JWT_REFRESH_SECRET: 'SensitiveJwtRefreshSecret_NeverInHealth_0002',
  INTERNAL_BOT_HMAC_SECRET: 'SensitiveBotHmacSecret_NeverInHealth_0000003',
  TELEGRAM_WEBHOOK_SECRET: 'SensitiveTgSecret_NeverInHealth_04',
};

function httpGetJson(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; rawBody: string; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            rawBody,
            json: JSON.parse(rawBody) as Record<string, unknown>,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('API Health Endpoint & Request ID Correlation (T03.02)', () => {
  it('returns minimal safe liveness response on GET /api/v1/health without secrets or false DB readiness claims', async () => {
    const config = loadApiEnv(TEST_ENV);
    const logs: RequestLogEntry[] = [];
    const app = await createApiApplication(config, (entry) => logs.push(entry));
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as http.Server;

    try {
      const port = (server.address() as AddressInfo).port;
      const res = await httpGetJson(port, '/api/v1/health', {
        'X-Request-Id': 'req-valid-20261104-0001',
        Authorization: 'Bearer SuperSecretBearerToken_ShouldBeRedacted',
        'X-Api-Key': 'SECRET_CUSTOM_API_KEY_MUST_NOT_LOG',
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-request-id'], 'req-valid-20261104-0001');
      assert.equal(res.json.status, 'OK');
      assert.equal(res.json.center_slug, 'guliston-ilm');
      assert.equal(res.json.license_mode, 'ACTIVE');
      assert.equal(res.json.request_id, 'req-valid-20261104-0001');
      assert.equal(typeof res.json.timestamp_utc, 'string');

      // Must only expose the 5 safe contract keys; no fake database healthy claim or secret leak
      assert.deepEqual(Object.keys(res.json).sort(), [
        'center_slug',
        'license_mode',
        'request_id',
        'status',
        'timestamp_utc',
      ]);
      assert.equal(res.rawBody.includes('SensitiveDbPass_NeverInHealth_42'), false);
      assert.equal(res.rawBody.includes('SensitiveJwtAccessSecret'), false);
      assert.equal(res.rawBody.includes('database'), false);

      // Verify structured request log correlation and header redaction
      assert.equal(logs.length, 1);
      assert.equal(logs[0].request_id, 'req-valid-20261104-0001');
      assert.equal(logs[0].path, '/api/v1/health');
      assert.equal(logs[0].status_code, 200);
      assert.equal(logs[0].redacted_headers.authorization, '[REDACTED]');
      assert.equal(JSON.stringify(logs[0]).includes('SuperSecretBearerToken_ShouldBeRedacted'), false);
      assert.equal(JSON.stringify(logs[0]).includes('SECRET_CUSTOM_API_KEY_MUST_NOT_LOG'), false);
    } finally {
      await app.close();
    }
  });

  it('replaces missing, oversized (>64 chars), or malformed X-Request-Id headers with a safe generated UUID', async () => {
    const config = loadApiEnv(TEST_ENV);
    const logs: RequestLogEntry[] = [];
    const app = await createApiApplication(config, (entry) => logs.push(entry));
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as http.Server;

    try {
      const port = (server.address() as AddressInfo).port;
      const oversizedId = 'x'.repeat(80);
      const resOversized = await httpGetJson(port, '/api/v1/health', {
        'X-Request-Id': oversizedId,
      });

      assert.equal(resOversized.statusCode, 200);
      const generatedId = resOversized.headers['x-request-id'] as string;
      assert.notEqual(generatedId, oversizedId);
      assert.match(generatedId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.equal(resOversized.json.request_id, generatedId);
      assert.equal(logs[0].request_id, generatedId);

      // Test unsafe characters in X-Request-Id
      const resUnsafe = await httpGetJson(port, '/api/v1/health', {
        'X-Request-Id': 'bad id with spaces and $pecial!',
      });
      const safeId2 = resUnsafe.headers['x-request-id'] as string;
      assert.match(safeId2, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.equal(resUnsafe.json.request_id, safeId2);
    } finally {
      await app.close();
    }
  });
});
