import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify, StatusResolver } from '../src/statuses.ts';

test('slugify collapses case and non-alphanumerics into a single underscore', () => {
  assert.equal(slugify('In Progress'), 'in_progress');
  assert.equal(slugify('MR / Process'), 'mr_process');
});

test('slugify strips leading and trailing junk', () => {
  assert.equal(slugify('  Standby !! '), 'standby');
  assert.equal(slugify('  ---  '), '');
});

test('resolveStatusId passes numeric ids through untouched', async () => {
  const resolver = new StatusResolver();
  assert.equal(await resolver.resolve(' 7 ', async () => []), 7);
});

test('resolveStatusId resolves an alias and memoises the discovered map', async () => {
  let calls = 0;
  const resolver = new StatusResolver();
  const discover = async () => {
    calls += 1;
    return [{ id: 123, name: 'In Progress' }];
  };

  assert.equal(await resolver.resolve('in_progress', discover), 123);
  assert.equal(await resolver.resolve('in_progress', discover), 123);
  assert.equal(calls, 1);
});

test('resolveStatusId lists the available aliases on a miss', async () => {
  const resolver = new StatusResolver();
  const discover = async () => [{ id: 123, name: 'In Progress' }];

  await assert.rejects(
    () => resolver.resolve('nope', discover),
    /Unknown status alias 'nope'.*in_progress/,
  );
});

test('resolveStatusId applies an env override on top of the discovered map', async () => {
  const resolver = new StatusResolver({ in_progress: 999 });
  const discover = async () => [{ id: 123, name: 'In Progress' }];

  assert.equal(await resolver.resolve('in_progress', discover), 999);
});

test('resolveStatusId exposes env-only aliases without calling discover', async () => {
  let calls = 0;
  const resolver = new StatusResolver({ wip: 999 });
  const discover = async () => {
    calls += 1;
    return [];
  };

  assert.equal(await resolver.resolve('wip', discover), 999);
  assert.equal(calls, 0);
});

test('resolveStatusId slugifies the lookup so spelling variants hit the same alias', async () => {
  const resolver = new StatusResolver();
  const discover = async () => [{ id: 123, name: 'In Progress' }];

  for (const spelling of ['In Progress', 'IN-PROGRESS', 'in progress', 'in_progress']) {
    assert.equal(await resolver.resolve(spelling, discover), 123, spelling);
  }
});

test('resolveStatusId throws a clear error for a colliding alias', async () => {
  const resolver = new StatusResolver();
  const discover = async () => [
    { id: 1, name: 'In Progress' },
    { id: 2, name: 'In-Progress' },
  ];

  await assert.rejects(() => resolver.resolve('in_progress', discover), /ambiguous.*ids 1, 2/);
});

test('statuses with empty slugs are skipped', async () => {
  const resolver = new StatusResolver();
  const discover = async () => [{ id: 1, name: '   ' }];

  await assert.rejects(() => resolver.resolve('whatever', discover), /Unknown status alias/);
});