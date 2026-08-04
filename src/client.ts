export type PaymoRecord = Record<string, unknown>;

export class PaymoHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Paymo API returned ${status}: ${body}`);
    this.name = 'PaymoHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface PaymoClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

interface RequestOptions {
  body?: PaymoRecord;
  form?: PaymoRecord;
}

export class PaymoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor({ apiKey, baseUrl, fetch: fetchImpl = globalThis.fetch }: PaymoClientOptions) {
    if (apiKey === '') {
      throw new Error('PAYMO_API_KEY is not configured.');
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  async me(): Promise<PaymoRecord> {
    return this.request('GET', '/me');
  }

  async currentUserId(): Promise<number> {
    const { users } = await this.me() as { users?: PaymoRecord[] };
    const id = users?.[0]?.id;

    if (typeof id !== 'number') {
      throw new Error('Unable to resolve current Paymo user id.');
    }

    return id;
  }

  async task(id: number): Promise<PaymoRecord> {
    const payload = await this.request('GET', `/tasks/${id}`);
    const task = (payload.tasks as PaymoRecord[] | undefined)?.[0];

    if (task === undefined) {
      throw new Error(`Task ${id} not found.`);
    }

    return task;
  }

  async taskByCode(code: string): Promise<PaymoRecord | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(code)) {
      throw new Error(`Invalid task code format: '${code}'.`);
    }

    const payload = await this.request('GET', `/tasks?${this.query({ where: `code=${code}` })}`);
    return (payload.tasks as PaymoRecord[] | undefined)?.[0] ?? null;
  }

  async resolveTaskId(identifier: string): Promise<number> {
    const trimmed = identifier.trim();

    if (trimmed === '') {
      throw new Error('Task identifier cannot be empty.');
    }

    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }

    const task = await this.taskByCode(trimmed.toUpperCase());

    if (task === null) {
      throw new Error(`Task code '${trimmed}' not found.`);
    }

    if (typeof task.id !== 'number') {
      throw new Error(`Task code '${trimmed}' not found.`);
    }

    return task.id;
  }

  async tasks(projectId: number, onlyOpen = true): Promise<PaymoRecord[]> {
    let where = `project_id=${projectId}`;

    if (onlyOpen) {
      where += ' and complete=false';
    }

    const payload = await this.request('GET', `/tasks?${this.query({ where })}`);
    return (payload.tasks as PaymoRecord[] | undefined) ?? [];
  }

  async projects(active: boolean): Promise<PaymoRecord[]> {
    const payload = await this.request(
      'GET',
      `/projects?${this.query({ where: `active=${active ? 'true' : 'false'}` })}`,
    );

    return (payload.projects as PaymoRecord[] | undefined) ?? [];
  }

  async tasklists(projectId: number | null): Promise<PaymoRecord[]> {
    const path = projectId === null
      ? '/tasklists'
      : `/tasklists?${this.query({ where: `project_id=${projectId}` })}`;

    const payload = await this.request('GET', path);
    return (payload.tasklists as PaymoRecord[] | undefined) ?? [];
  }

  async workflowStatuses(): Promise<PaymoRecord[]> {
    const payload = await this.request('GET', '/workflowstatuses');
    return (payload.workflowstatuses as PaymoRecord[] | undefined) ?? [];
  }

  async runningEntry(userId: number): Promise<PaymoRecord | null> {
    const payload = await this.request(
      'GET',
      `/entries?${this.query({ where: `end_time=null and user_id=${userId}` })}`,
    );

    return (payload.entries as PaymoRecord[] | undefined)?.[0] ?? null;
  }

  async createTask(data: PaymoRecord): Promise<PaymoRecord> {
    const payload = await this.request('POST', '/tasks', { body: data });
    const task = (payload.tasks as PaymoRecord[] | undefined)?.[0];

    if (task === undefined) {
      throw new Error('Paymo did not return a created task.');
    }

    return task;
  }

  async updateTask(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    const payload = await this.request('PUT', `/tasks/${id}`, { body: data });
    const task = (payload.tasks as PaymoRecord[] | undefined)?.[0];

    if (task === undefined) {
      throw new Error(`Task ${id} update did not return a task.`);
    }

    return task;
  }

  async addComment(taskId: number, content: string): Promise<PaymoRecord> {
    const payload = await this.request('POST', '/comments', {
      form: { task_id: taskId, content },
    });
    const comment = (payload.comments as PaymoRecord[] | undefined)?.[0];

    if (comment === undefined) {
      throw new Error(`Could not add comment to task ${taskId}.`);
    }

    return comment;
  }

  async startEntry(taskId: number): Promise<PaymoRecord> {
    const payload = await this.request('POST', '/entries', {
      body: {
        task_id: taskId,
        start_time: this.nowUtc(),
      },
    });
    const entry = (payload.entries as PaymoRecord[] | undefined)?.[0];

    if (entry === undefined) {
      throw new Error('Paymo did not return a created entry.');
    }

    return entry;
  }

  async stopEntry(entryId: number): Promise<PaymoRecord> {
    const payload = await this.request('PUT', `/entries/${entryId}`, {
      body: { end_time: this.nowUtc() },
    });
    const entry = (payload.entries as PaymoRecord[] | undefined)?.[0];

    if (entry === undefined) {
      throw new Error(`Entry ${entryId} update did not return an entry.`);
    }

    return entry;
  }

  taskUrl(projectId: number, taskId: number): string {
    const webBaseUrl = this.baseUrl.replace(/\/api\/?$/, '');
    return `${webBaseUrl}/#/Paymo.Projects/${projectId}/tasks/complex/task/${taskId}`;
  }

  private nowUtc(): string {
    return `${new Date().toISOString().slice(0, 19)}Z`;
  }

  private query(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  private async request(method: string, path: string, options: RequestOptions = {}): Promise<PaymoRecord> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.apiKey}:X`).toString('base64')}`,
      Accept: 'application/json',
    };

    let body: string | undefined;

    if (options.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(
        Object.entries(options.form).map(([key, value]) => [key, String(value)] as [string, string]),
      ).toString();
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let response: Response;

    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new PaymoHttpError(response.status, await response.text());
    }

    const text = await response.text();

    if (text === '') {
      return {};
    }

    return JSON.parse(text) as PaymoRecord;
  }
}
