import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ProcedureMemory, overlapScore, redact, tokenize} from './procedureMemory.js';

test('retrieves a stored Rapido booking playbook for a similar goal', () => {
  const memory = new ProcedureMemory(null);
  const hits = memory.retrieve({goal: 'book me a bike from here to rajiv chowk metro', app: 'com.rapido.passenger'});
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].apps.includes('com.rapido.passenger'), true);
  assert.ok(hits[0].playbook.some(step => step.capability === 'open_app'));
  assert.ok(hits[0].pitfalls.some(item => /cannot find you|gps/i.test(item)));
});

test('learned success is remembered and merged on repeat', () => {
  const memory = new ProcedureMemory(null);
  const first = memory.remember({
    goal: 'Open calculator and multiply 25 by 4',
    apps: ['com.google.android.calculator'],
    playbook: [
      {capability: 'open_app', args: {packageName: 'com.google.android.calculator'}},
      {capability: 'find_and_click', args: {text: '2'}},
      {capability: 'find_and_click', args: {text: '5'}},
      {capability: 'find_and_click', args: {text: '×'}},
    ],
    outcome: 'success',
  });
  const again = memory.remember({
    goal: 'calculator 25 times 4',
    apps: ['com.google.android.calculator'],
    playbook: [
      {capability: 'open_app', args: {packageName: 'com.google.android.calculator'}},
      {capability: 'find_and_click', args: {text: '2'}},
      {capability: 'find_and_click', args: {text: '5'}},
    ],
    outcome: 'success',
  });
  assert.equal(again.id, first.id);
  assert.ok(again.uses >= 2);
  const hits = memory.retrieve({goal: 'do 25 x 4 on calculator', app: 'com.google.android.calculator'});
  assert.ok(hits.some(item => item.id === first.id));
});

test('book and cancel playbooks stay separate', () => {
  const memory = new ProcedureMemory(null);
  const book = memory.retrieve({goal: 'book a bike to rajiv chowk metro'});
  const cancel = memory.retrieve({goal: 'cancel the rapido ride'});
  assert.ok(book[0]?.goal.toLowerCase().includes('book'));
  assert.ok(cancel[0]?.goal.toLowerCase().includes('cancel'));
  assert.notEqual(book[0]?.id, cancel[0]?.id);
});

test('redacts pins and long numbers from stored text', () => {
  assert.match(redact('Start PIN : 6997'), /\[number\]|\[redacted\]/);
  assert.ok(tokenize('book a bike to metro').includes('bike'));
  assert.ok(overlapScore(['bike', 'metro'], ['bike', 'metro', 'rapido']) >= 2);
});
