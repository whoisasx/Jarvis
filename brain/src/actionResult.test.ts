import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inferErrorCode, parseActionResult} from './actionResult.js';

test('success and ok normalize to {ok:true}', () => {
  assert.deepEqual(parseActionResult('success'), {success: true, data: {ok: true}});
  assert.deepEqual(parseActionResult('ok'), {success: true, data: {ok: true}});
});

test('success-prefixed JSON objects keep payload and add ok', () => {
  assert.deepEqual(parseActionResult('success: {"packageName":"com.android.chrome"}'), {
    success: true,
    data: {ok: true, packageName: 'com.android.chrome'},
  });
});

test('success-prefixed arrays stay arrays so list_apps is unchanged', () => {
  assert.deepEqual(parseActionResult('success: [{"label":"Chrome"}]'), {
    success: true,
    data: [{label: 'Chrome'}],
  });
});

test('package names containing permission do not look like failures', () => {
  const result = parseActionResult('success: [{"packageName":"com.google.android.permissioncontroller"}]');
  assert.equal(result.success, true);
  assert.equal(Array.isArray(result.data), true);
});

test('found and not_found are deterministic', () => {
  assert.deepEqual(parseActionResult('found: tree-1-node-2'), {
    success: true,
    data: {ok: true, elementId: 'tree-1-node-2', found: 'tree-1-node-2'},
  });
  assert.equal(parseActionResult('not_found').success, false);
});

test('failed messages map to error codes', () => {
  assert.equal(inferErrorCode('failed: ELEMENT_STALE'), 'ELEMENT_STALE');
  assert.equal(inferErrorCode('failed: NO_ACTIVE_CALL'), 'NO_ACTIVE_CALL');
  assert.equal(inferErrorCode('failed: CHOOSER_AMBIGUOUS'), 'CHOOSER_AMBIGUOUS');
  assert.equal(inferErrorCode('failed: NOT_DEFAULT_SMS_APP'), 'NOT_DEFAULT_SMS_APP');
  assert.equal(inferErrorCode('failed: COMPOSE_UNAVAILABLE'), 'COMPOSE_UNAVAILABLE');
  assert.equal(inferErrorCode('failed: NO_VISIBLE_CHANGE'), 'NO_VISIBLE_CHANGE');
  assert.equal(inferErrorCode('failed: MATCH_AMBIGUOUS'), 'MATCH_AMBIGUOUS');
});
