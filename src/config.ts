import { slugify } from './statuses.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type PermissionMode = 'readonly' | 'modify' | 'full';

export interface Config {
  apiKey: string;
  baseUrl: string;
  defaultProjectId: number | null;
  permissionMode: PermissionMode;
  statusAliases: Record<string, number>;
  toolsets: string[];
  tools: string[];
  deniedToolsRegex: RegExp | null;
  deprecation: string | null;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

export function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = raw.trim().toLowerCase();

  if (TRUTHY.has(value)) {
    return true;
  }

  if (FALSY.has(value)) {
    return false;
  }

  throw new ConfigError(
    `Invalid ${name}: '${raw}'. Use one of ${[...TRUTHY, ...FALSY].join(', ')}.`,
  );
}

export function parseProjectId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const id = Number(raw);

  if (!Number.isInteger(id) || id <= 0) {
    throw new ConfigError(
      `Invalid PAYMO_DEFAULT_PROJECT_ID: '${raw}'. Expected a positive integer.`,
    );
  }

  return id;
}

/**
 * Keys are slugified so that `{"In Progress": 1}` resolves the same way a discovered
 * status name does; values must be positive integers, since a NaN status_id serialises
 * to null and Paymo accepts it without complaint.
 */
export function parseStatusAliases(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw.trim() === '') {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `Invalid PAYMO_STATUS_ALIASES (expected a JSON object like {"wip":123}): ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('Invalid PAYMO_STATUS_ALIASES: expected a JSON object like {"wip":123}.');
  }

  const aliases: Record<string, number> = {};

  for (const [key, value] of Object.entries(parsed)) {
    const alias = slugify(key);

    if (alias === '') {
      throw new ConfigError(`Invalid PAYMO_STATUS_ALIASES: '${key}' is not a usable alias name.`);
    }

    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new ConfigError(
        `Invalid PAYMO_STATUS_ALIASES: alias '${key}' must be a positive integer status id, got ${JSON.stringify(value)}.`,
      );
    }

    aliases[alias] = value;
  }

  return aliases;
}

/**
 * Splits a comma-separated env value into trimmed names, dropping empty pieces so a trailing comma
 * or a stray space never resolves to a phantom name. `PAYMO_TOOLSETS` names are lowercased at
 * resolution time, not here, because `PAYMO_TOOLS` must stay exactly as registered.
 */
function parseNameList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }

  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

function parseDeniedRegex(raw: string | undefined): RegExp | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  try {
    return new RegExp(raw);
  } catch (err) {
    throw new ConfigError(
      `Invalid PAYMO_DENIED_TOOLS_REGEX: '${raw}'. ${(err as Error).message}`,
    );
  }
}

/**
 * `PAYMO_PERMISSION_MODE` and the deprecated `PAYMO_READ_ONLY` alias. Setting both is a hard error
 * rather than a precedence matrix — the operator is told to drop the deprecated one instead of
 * guessing which value won. `PAYMO_READ_ONLY=false` maps to `modify`, not to `full`, because the
 * package's default is now three levels and a delete guardrail.
 */
function parsePermissionMode(env: NodeJS.ProcessEnv): {
  mode: PermissionMode;
  deprecation: string | null;
} {
  const modeRaw = env.PAYMO_PERMISSION_MODE ?? '';
  const readOnlyRaw = env.PAYMO_READ_ONLY ?? '';

  if (modeRaw.trim() !== '' && readOnlyRaw.trim() !== '') {
    throw new ConfigError(
      'Set either PAYMO_PERMISSION_MODE or PAYMO_READ_ONLY, not both. '
        + 'PAYMO_READ_ONLY is deprecated; remove it and use PAYMO_PERMISSION_MODE instead.',
    );
  }

  if (modeRaw.trim() !== '') {
    const mode = modeRaw.trim().toLowerCase();

    if (mode !== 'readonly' && mode !== 'modify' && mode !== 'full') {
      throw new ConfigError(
        `Invalid PAYMO_PERMISSION_MODE: '${modeRaw}'. Use one of: readonly, modify, full.`,
      );
    }

    return { mode, deprecation: null };
  }

  if (readOnlyRaw.trim() !== '') {
    const value = parseBoolean('PAYMO_READ_ONLY', readOnlyRaw, false);

    return {
      mode: value ? 'readonly' : 'modify',
      deprecation: 'PAYMO_READ_ONLY is deprecated; set PAYMO_PERMISSION_MODE=modify (or readonly) instead.',
    };
  }

  return { mode: 'modify', deprecation: null };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.PAYMO_API_KEY ?? '';

  if (apiKey.trim() === '') {
    throw new ConfigError(
      'PAYMO_API_KEY is required. Create an API key in your Paymo account settings and set it in the environment.',
    );
  }

  const { mode, deprecation } = parsePermissionMode(env);

  return {
    apiKey,
    baseUrl: env.PAYMO_BASE_URL ?? 'https://app.paymoapp.com/api',
    defaultProjectId: parseProjectId(env.PAYMO_DEFAULT_PROJECT_ID),
    permissionMode: mode,
    statusAliases: parseStatusAliases(env.PAYMO_STATUS_ALIASES),
    toolsets: parseNameList(env.PAYMO_TOOLSETS),
    tools: parseNameList(env.PAYMO_TOOLS),
    deniedToolsRegex: parseDeniedRegex(env.PAYMO_DENIED_TOOLS_REGEX),
    deprecation,
  };
}