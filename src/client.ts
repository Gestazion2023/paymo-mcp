export type PaymoRecord = Record<string, unknown>;

const MAX_ERROR_BODY = 400;

/**
 * The body is truncated because it reaches an LLM context verbatim: an API error is a
 * short JSON document, but a WAF or proxy in front of Paymo answers with a full HTML
 * page, and a few kilobytes of markup crowd out the conversation for no diagnostic gain.
 */
export class PaymoHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    const collapsed = body.replace(/\s+/g, ' ').trim();
    const summary = collapsed.length > MAX_ERROR_BODY
      ? `${collapsed.slice(0, MAX_ERROR_BODY)}… (${collapsed.length} chars truncated)`
      : collapsed;

    super(`Paymo API returned ${status}: ${summary}`);
    this.name = 'PaymoHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface PaymoClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Upper bound on how long a 429 is allowed to stall a tool call. */
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

interface RequestOptions {
  body?: PaymoRecord;
  form?: PaymoRecord;
}

export class PaymoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({
    apiKey,
    baseUrl,
    fetch: fetchImpl = globalThis.fetch,
    sleep = (ms: number): Promise<void> => new Promise((resolve): void => {
      setTimeout(resolve, ms);
    }),
  }: PaymoClientOptions) {
    if (apiKey === '') {
      throw new Error('PAYMO_API_KEY is not configured.');
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
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

  /**
   * Edits a comment in place. Sent form-encoded for the same reason `addComment` is: `/comments`
   * is the one endpoint in this API that rejects a JSON body (see the API quirks in the plans).
   * Unverified live — the change that added it was not allowed to call the real API.
   */
  async updateComment(commentId: number, content: string): Promise<PaymoRecord> {
    const payload = await this.request('PUT', `/comments/${commentId}`, { form: { content } });
    const comment = (payload.comments as PaymoRecord[] | undefined)?.[0];

    if (comment === undefined) {
      throw new Error(`Comment ${commentId} update did not return a comment.`);
    }

    return comment;
  }

  /**
   * Comments are a resource of their own, not a field of the task, so reading a task's
   * conversation is a filtered listing rather than an `include` on the task read.
   */
  async comments(taskId: number): Promise<PaymoRecord[]> {
    return this.list('comments', 'comments', `task_id=${taskId}`);
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

  private nowUtc(): string {
    return `${new Date().toISOString().slice(0, 19)}Z`;
  }

  private query(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  async deleteEntry(entryId: number): Promise<void> {
    await this.request('DELETE', `/entries/${entryId}`);
  }

  // --- Generic CRUD helpers ----------------------------------------------
  // Resource paths and the plural response keys they answer under do not always match
  // (`/projecttemplates` answers under `project_templates`, not `projecttemplates`), so each
  // caller passes its known key explicitly rather than trying to derive it.
  async list(resource: string, pluralKey: string, where?: string): Promise<PaymoRecord[]> {
    const path = where === undefined
      ? `/${resource}`
      : `/${resource}?${this.query({ where })}`;

    const payload = await this.request('GET', path);
    return (payload[pluralKey] as PaymoRecord[] | undefined) ?? [];
  }

  async one(resource: string, pluralKey: string, id: number): Promise<PaymoRecord> {
    const payload = await this.request('GET', `/${resource}/${id}`);
    const record = (payload[pluralKey] as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`${resource} ${id} not found.`);
    }

    return record;
  }

  async create(resource: string, pluralKey: string, data: PaymoRecord): Promise<PaymoRecord> {
    const payload = await this.request('POST', `/${resource}`, { body: data });
    const record = (payload[pluralKey] as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`Paymo did not return a created ${resource} record.`);
    }

    return record;
  }

  async update(resource: string, pluralKey: string, id: number, data: PaymoRecord): Promise<PaymoRecord> {
    const payload = await this.request('PUT', `/${resource}/${id}`, { body: data });
    const record = (payload[pluralKey] as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`${resource} ${id} update did not return a record.`);
    }

    return record;
  }

  // --- Projects and tasklists --------------------------------------------
  async project(id: number): Promise<PaymoRecord> {
    return this.one('projects', 'projects', id);
  }

  async projectTemplates(): Promise<PaymoRecord[]> {
    return this.list('projecttemplates', 'project_templates');
  }

  async projectStatuses(): Promise<PaymoRecord[]> {
    return this.list('projectstatuses', 'projectstatuses');
  }

  async createProject(data: PaymoRecord): Promise<PaymoRecord> {
    return this.create('projects', 'projects', data);
  }

  async updateProject(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    return this.update('projects', 'projects', id, data);
  }

  async createTasklist(data: PaymoRecord): Promise<PaymoRecord> {
    return this.create('tasklists', 'tasklists', data);
  }

  async updateTasklist(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    return this.update('tasklists', 'tasklists', id, data);
  }

  // --- Clients, client contacts and company ------------------------------
  async clients(active: boolean): Promise<PaymoRecord[]> {
    return this.list('clients', 'clients', `active=${active ? 'true' : 'false'}`);
  }

  async client(id: number): Promise<PaymoRecord> {
    return this.one('clients', 'clients', id);
  }

  async createClient(data: PaymoRecord): Promise<PaymoRecord> {
    return this.create('clients', 'clients', data);
  }

  async updateClient(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    return this.update('clients', 'clients', id, data);
  }

  async clientContacts(clientId: number | null): Promise<PaymoRecord[]> {
    return this.list(
      'clientcontacts',
      'clientcontacts',
      clientId === null ? undefined : `client_id=${clientId}`,
    );
  }

  async createClientContact(data: PaymoRecord): Promise<PaymoRecord> {
    return this.create('clientcontacts', 'clientcontacts', data);
  }

  async updateClientContact(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    return this.update('clientcontacts', 'clientcontacts', id, data);
  }

  // --- Billing (invoices, invoice payments, estimates, invoice templates) ---
  async invoices(where?: string): Promise<PaymoRecord[]> {
    return this.list('invoices', 'invoices', where);
  }

  async invoicePayments(invoiceId: number | null): Promise<PaymoRecord[]> {
    return this.list(
      'invoicepayments',
      'invoicepayments',
      invoiceId === null ? undefined : `invoice_id=${invoiceId}`,
    );
  }

  async estimates(where?: string): Promise<PaymoRecord[]> {
    return this.list('estimates', 'estimates', where);
  }

  async invoiceTemplates(): Promise<PaymoRecord[]> {
    return this.list('invoicetemplates', 'invoicetemplates');
  }

  /**
   * The detail reads ride the generic `one` helper only as far as the resolves, but both need
   * `?include=…items` to return their line items — the plan's `paymo_get_invoice` and
   * `paymo_get_estimate` are explicitly "detail, including line items". `one` takes no query, so
   * these are hand-written.
   */
  async invoice(id: number): Promise<PaymoRecord> {
    const payload = await this.request('GET', `/invoices/${id}?include=invoiceitems`);
    const record = (payload.invoices as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`Invoice ${id} not found.`);
    }

    return record;
  }

  async estimate(id: number): Promise<PaymoRecord> {
    const payload = await this.request('GET', `/estimates/${id}?include=estimateitems`);
    const record = (payload.estimates as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`Estimate ${id} not found.`);
    }

    return record;
  }

  /**
   * `company` is the one record returned as a single object (`{"company":{…}}`) rather than
   * wrapped in an array like every other record, so it cannot ride the generic helpers.
   */
  async company(): Promise<PaymoRecord> {
    const payload = await this.request('GET', '/company');
    const record = payload.company as PaymoRecord | undefined;

    if (record === undefined) {
      throw new Error('Paymo did not return a company record.');
    }

    return record;
  }

  /**
   * Paymo advertises the window it wants us to wait through `X-Ratelimit-Decay-Period`,
   * so honour that rather than guessing a backoff curve.
   */
  private retryDelayMs(response: Response): number {
    const seconds = Number(response.headers.get('x-ratelimit-decay-period'));
    const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_DELAY_MS;

    return Math.min(delay, MAX_RETRY_DELAY_MS);
  }

  private async request(
    method: string,
    path: string,
    options: RequestOptions = {},
    isRetry = false,
  ): Promise<PaymoRecord> {
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

    if (response.status === 429 && !isRetry) {
      await this.sleep(this.retryDelayMs(response));

      return this.request(method, path, options, true);
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
