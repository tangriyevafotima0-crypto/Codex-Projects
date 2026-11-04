import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { loadOpenApiContractDocument, resolveOpenApiContractPath, resolveOperationInventoryPath } from '../src/index';

it('loads canonical contracts while npm runs from a workspace directory', () => {
  assert.ok(existsSync(resolveOpenApiContractPath()));
  assert.ok(existsSync(resolveOperationInventoryPath()));
  assert.equal(loadOpenApiContractDocument().openapi, '3.1.0');
});
