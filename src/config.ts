import { slugify } from './statuses.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  apiKey: string;
  baseUrl: string;
  defaultProjectId: number | null;
  readOnly: boolean;
  statusAliases: Record<string, number>;
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

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.PAYMO_API_KEY ?? '';

  if (apiKey.trim() === '') {
    throw new ConfigError(
      'PAYMO_API_KEY is required. Create an API key in your Paymo account settings and set it in the environment.',
    );
  }

  return {
    apiKey,
    baseUrl: env.PAYMO_BASE_URL ?? 'https://app.paymoapp.com/api',
    defaultProjectId: parseProjectId(env.PAYMO_DEFAULT_PROJECT_ID),
    readOnly: parseBoolean('PAYMO_READ_ONLY', env.PAYMO_READ_ONLY, false),
    statusAliases: parseStatusAliases(env.PAYMO_STATUS_ALIASES),
  };
}