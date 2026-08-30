import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CAPABILITY_CATALOG, findCapability} from './capabilityCatalog.js';

const REQUIRED = [
  'resolve_app', 'open_app', 'open_url', 'wait', 'read_screen',
  'find_element', 'click_element', 'find_and_click', 'find_and_tap',
  'focus_element', 'type_text', 'press_key', 'press_back',
  'end_call', 'make_call', 'get_recent_calls', 'get_notifications',
  'get_device_profile', 'get_world_state', 'get_recent_events',
  'search_memory', 'get_relevant_context', 'get_similar_procedures',
  'remember_procedure', 'complete_task', 'list_apps',
  'read_sms', 'send_sms', 'compose_message', 'resolve_chooser',
];

test('canonical catalog exposes every V1 capability once', () => {
  const names = CAPABILITY_CATALOG.map(item => item.name);
  for (const name of REQUIRED) {
    assert.equal(names.filter(item => item === name).length, 1, name);
    const tool = findCapability(name);
    assert.ok(tool?.inputSchema);
    assert.ok(tool?.description);
  }
});

test('send_sms and make_call remain sensitive', () => {
  assert.equal(findCapability('send_sms')?.sensitive, true);
  assert.equal(findCapability('make_call')?.sensitive, true);
  assert.equal(findCapability('compose_message')?.sensitive, false);
  assert.equal(findCapability('end_call')?.sensitive, false);
});
