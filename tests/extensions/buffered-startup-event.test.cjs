'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BufferedStartupEvent } = require('../../dist-electron/buffered-startup-event.js');
const flush = () => new Promise((resolve) => queueMicrotask(resolve));

test('startup restore arriving before React mounts is delivered once to the live effect', async () => {
  const events = [];
  const buffer = new BufferedStartupEvent(assert.fail);
  buffer.publish('/workspace/restored');
  await flush();

  const discarded = buffer.subscribe((value) => events.push(['discarded', value]));
  discarded.dispose();
  const active = buffer.subscribe((value) => events.push(['active', value]));
  await flush();
  assert.deepEqual(events, [['active', '/workspace/restored']]);

  active.dispose();
  const remounted = buffer.subscribe((value) => events.push(['remounted', value]));
  await flush();
  assert.equal(events.length, 1, 'a consumed restore is not replayed on later mounts');
  remounted.dispose();
});

test('disposing before deferred delivery preserves the restore for the next subscriber', async () => {
  const events = [];
  const buffer = new BufferedStartupEvent(assert.fail);
  const old = buffer.subscribe((value) => events.push(value));
  buffer.publish('/workspace/old');
  old.dispose();
  await flush();
  buffer.publish('/workspace/latest');

  const current = buffer.subscribe((value) => events.push(value));
  await flush();
  assert.deepEqual(events, ['/workspace/latest']);
  current.dispose();
  current.dispose();
});

test('live subscriptions receive new restores and one failing listener does not lose the event', async () => {
  const errors = [];
  const events = [];
  const buffer = new BufferedStartupEvent((error) => errors.push(error.message));
  const failing = buffer.subscribe(() => { throw new Error('listener failed'); });
  const current = buffer.subscribe((value) => events.push(value));
  buffer.publish('/workspace/first');
  await flush();
  failing.dispose();
  buffer.publish('/workspace/second');
  await flush();
  assert.deepEqual(events, ['/workspace/first', '/workspace/second']);
  assert.deepEqual(errors, ['listener failed']);
  current.dispose();
});
