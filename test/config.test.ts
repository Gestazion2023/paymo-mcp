import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig, parseBoolean, parseProjectId, parseStatusAliases } from '../src/config.ts';

test('parseBoolean accepts the usual spellings of true and false', () => {
  for (const raw of ['1', 'true', 'TRUE', ' yes ', 'on']) {
    assert.equal(parseBoolean('PAYMO_READ_ONLY', raw, false), true, raw);
  }

  for (const raw of ['0', 'false', 'NO', 'off']) {
    assert.equal(parseBoolean('PAYMO_READ_ONLY', raw, true), false, raw);
  }
});

test('parseBoolean falls back when unset or empty', () => {
  assert.equal(parseBoolean('PAYMO_READ_ONLY', undefined, false), false);
  assert.equal(parseBoolean('PAYMO_READ_ONLY', '  ', true), true);
});

test('parseBoolean refuses an unrecognised value rather than guessing', () => {
  assert.throws(
    () => parseBoolean('PAYMO_READ_ONLY', 'sure', false),
    /Invalid PAYMO_READ_ONLY: 'sure'/,
  );
});

test('parseProjectId returns null when unset and rejects non-positive integers', () => {
  assert.equal(parseProjectId(undefined), null);
  assert.equal(parseProjectId(''), null);
  assert.equal(parseProjectId('1234'), 1234);

  for (const raw of ['0', '-1', '1.5', 'abc']) {
    assert.throws(() => parseProjectId(raw), /Invalid PAYMO_DEFAULT_PROJECT_ID/, raw);
  }
});

test('parseStatusAliases slugifies keys so spelling variants resolve alike', () => {
  assert.deepEqual(parseStatusAliases('{"In Progress":1,"MR / Process":2}'), {
    in_progress: 1,
    mr_process: 2,
  });
});

test('parseStatusAliases returns an empty map when unset', () => {
  assert.deepEqual(parseStatusAliases(undefined), {});
  assert.deepEqual(parseStatusAliases(''), {});
});

test('parseStatusAliases rejects values that would become a null status id', () => {
  for (const raw of ['{"wip":"abc"}', '{"wip":null}', '{"wip":1.5}', '{"wip":0}', '{"wip":-3}']) {
    assert.throws(() => parseStatusAliases(raw), /alias 'wip' must be a positive integer/, raw);
  }
});

test('parseStatusAliases rejects malformed JSON and non-objects', () => {
  assert.throws(() => parseStatusAliases('{nope'), /expected a JSON object/);
  assert.throws(() => parseStatusAliases('[1,2]'), /expected a JSON object/);
  assert.throws(() => parseStatusAliases('"wip"'), /expected a JSON object/);
});

test('parseStatusAliases rejects a key with no usable slug', () => {
  assert.throws(() => parseStatusAliases('{"---":1}'), /is not a usable alias name/);
});

test('loadConfig requires an api key', () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ PAYMO_API_KEY: '   ' }), /PAYMO_API_KEY is required/);
});

test('loadConfig applies defaults around a bare api key', () => {
  assert.deepEqual(loadConfig({ PAYMO_API_KEY: 'k' }), {
    apiKey: 'k',
    baseUrl: 'https://app.paymoapp.com/api',
    uploadDir: null,
    defaultProjectId: null,
    permissionMode: 'modify',
    statusAliases: {},
    toolsets: [],
    tools: [],
    deniedToolsRegex: null,
    deprecation: null,
  });
});

test('loadConfig reads every supported variable', () => {
  assert.deepEqual(
    loadConfig({
      PAYMO_API_KEY: 'k',
      PAYMO_BASE_URL: 'https://example.test/api',
      PAYMO_UPLOAD_DIR: ' /srv/uploads ',
      PAYMO_DEFAULT_PROJECT_ID: '1234',
      PAYMO_PERMISSION_MODE: 'readonly',
      PAYMO_STATUS_ALIASES: '{"wip":7}',
      PAYMO_TOOLSETS: ' context, tasks ',
      PAYMO_TOOLS: 'paymo_create_task, paymo_update_task',
      PAYMO_DENIED_TOOLS_REGEX: '^paymo_update',
    }),
    {
      apiKey: 'k',
      baseUrl: 'https://example.test/api',
      uploadDir: '/srv/uploads',
      defaultProjectId: 1234,
      permissionMode: 'readonly',
      statusAliases: { wip: 7 },
      toolsets: ['context', 'tasks'],
      tools: ['paymo_create_task', 'paymo_update_task'],
      deniedToolsRegex: /^paymo_update/,
      deprecation: null,
    },
  );
});

test('PAYMO_PERMISSION_MODE accepts the three modes case-insensitively', () => {
  for (const [raw, mode] of [['readonly', 'readonly'], ['MODIFY', 'modify'], [' Full ', 'full']]) {
    assert.equal(loadConfig({ PAYMO_API_KEY: 'k', PAYMO_PERMISSION_MODE: raw }).permissionMode, mode, raw);
  }
});

test('PAYMO_PERMISSION_MODE refuses an unknown value', () => {
  assert.throws(
    () => loadConfig({ PAYMO_API_KEY: 'k', PAYMO_PERMISSION_MODE: 'write' }),
    /Invalid PAYMO_PERMISSION_MODE: 'write'.*readonly, modify, full/,
  );
});

test('PAYMO_READ_ONLY maps to readonly and modify and reports a deprecation notice', () => {
  const ro = loadConfig({ PAYMO_API_KEY: 'k', PAYMO_READ_ONLY: 'true' });

  assert.equal(ro.permissionMode, 'readonly');
  assert.match(ro.deprecation, /PAYMO_PERMISSION_MODE/);

  const rw = loadConfig({ PAYMO_API_KEY: 'k', PAYMO_READ_ONLY: 'false' });

  assert.equal(rw.permissionMode, 'modify');
  assert.match(rw.deprecation, /PAYMO_PERMISSION_MODE/);
});

test('setting both PAYMO_PERMISSION_MODE and PAYMO_READ_ONLY aborts', () => {
  assert.throws(
    () => loadConfig({ PAYMO_API_KEY: 'k', PAYMO_PERMISSION_MODE: 'full', PAYMO_READ_ONLY: '1' }),
    /either PAYMO_PERMISSION_MODE or PAYMO_READ_ONLY/,
  );
});

test('PAYMO_DENIED_TOOLS_REGEX that does not compile aborts', () => {
  assert.throws(
    () => loadConfig({ PAYMO_API_KEY: 'k', PAYMO_DENIED_TOOLS_REGEX: '(' }),
    /Invalid PAYMO_DENIED_TOOLS_REGEX/,
  );
});