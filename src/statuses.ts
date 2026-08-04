import type { PaymoRecord } from './client.ts';

export type StatusDiscover = () => Promise<PaymoRecord[]>;

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export class StatusResolver {
  private map: Record<string, number> | null = null;
  private collisions: Record<string, number[]> = {};
  private readonly envAliases: Record<string, number>;

  constructor(envAliases: Record<string, number> = {}) {
    this.envAliases = envAliases;
  }

  async resolve(identifier: string, discover: StatusDiscover): Promise<number> {
    const trimmed = identifier.trim();

    if (trimmed === '') {
      throw new Error('Status identifier cannot be empty.');
    }

    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }

    await this.ensureMap(discover);

    const key = trimmed.toLowerCase();

    if (key in this.envAliases) {
      return this.envAliases[key]!;
    }

    const value = this.map?.[key];

    if (value === undefined) {
      const aliases = Object.keys({ ...this.map, ...this.envAliases });
      throw new Error(
        `Unknown status alias '${identifier}'. Use a numeric id or one of: ${aliases.join(', ')}.`,
      );
    }

    const ambiguous = this.collisions[key];

    if (ambiguous !== undefined && ambiguous.length > 0) {
      throw new Error(
        `Status alias '${identifier}' is ambiguous (ids ${[value, ...ambiguous].join(', ')}). Use a numeric id.`,
      );
    }

    return value;
  }

  private async ensureMap(discover: StatusDiscover): Promise<void> {
    if (this.map !== null) {
      return;
    }

    const discovered: Record<string, number> = {};
    const collisions: Record<string, number[]> = {};

    const statuses = await discover();

    for (const status of statuses) {
      const { id, name } = status;

      if (typeof id !== 'number' || typeof name !== 'string') {
        continue;
      }

      const alias = slugify(name);

      if (alias === '') {
        continue;
      }

      if (alias in discovered) {
        collisions[alias] ??= [];
        if (!collisions[alias]!.includes(id)) {
          collisions[alias]!.push(id);
        }
        continue;
      }

      discovered[alias] = id;
    }

    this.collisions = collisions;
    this.map = discovered;
  }
}