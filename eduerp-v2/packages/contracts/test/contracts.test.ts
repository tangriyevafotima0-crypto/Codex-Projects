import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { applyOfflineAttendanceSyncAck, loadOpenApiContractDocument, OfflineAttendanceQueueItemContract, resolveOpenApiContractPath, resolveOperationInventoryPath } from '../src/index';

it('loads canonical contracts while npm runs from a workspace directory', () => {
  assert.ok(existsSync(resolveOpenApiContractPath()));
  assert.ok(existsSync(resolveOperationInventoryPath()));
  assert.equal(loadOpenApiContractDocument().openapi, '3.1.0');
});

it('rejects ACK_COMMITTED / ACK_IDEMPOTENT_REPLAY when server_version is null or < 1', () => {
  const item: OfflineAttendanceQueueItemContract = {
    client_operation_uuid: '11111111-1111-4111-8111-111111111111',
    lesson_id: '22222222-2222-4222-8222-222222222222',
    expected_version: 1,
    payload_sha256: 'a'.repeat(64),
    state: 'PENDING',
    synced_server_version: null,
    last_ack_status: null,
    last_error_code: null,
    conflict_details_json: null,
  };
  const badAck = applyOfflineAttendanceSyncAck([item], [
    {
      client_operation_uuid: item.client_operation_uuid,
      lesson_id: item.lesson_id,
      ack_status: 'ACK_COMMITTED',
      server_version: null,
      error_code: null,
    },
  ]);
  assert.equal(badAck[0].state, 'PENDING');
  assert.equal(badAck[0].last_error_code, 'INVALID_ACK_SERVER_VERSION');
});
