import { z } from 'zod';
import type { PaymoRecord } from '../client.ts';
import { filterRecord, paginate } from '../fields.ts';
import { limit, offset, respond, verbose } from './shared.ts';
import type { ToolDef } from './shared.ts';

const clientId = z.number().int().describe('Paymo client id.');
const contactId = z.number().int().describe('Paymo client contact id.');

const CLIENT_WRITE_FIELDS = [
  'name', 'email', 'phone', 'fax', 'website', 'address', 'city', 'state', 'postal_code',
  'country', 'fiscal_information',
] as const;

const CONTACT_WRITE_FIELDS = [
  'name', 'email', 'mobile', 'phone', 'fax', 'skype', 'position', 'is_main', 'access', 'notes',
] as const;

function collect<T extends PaymoRecord>(args: T, keys: readonly string[]): PaymoRecord {
  const payload: PaymoRecord = {};

  for (const key of keys) {
    if (args[key] !== undefined) {
      payload[key] = args[key];
    }
  }

  return payload;
}

export const clientsTools: Record<string, ToolDef> = {
  paymo_list_clients: {
    level: 'read',
    description:
      'List Paymo clients. Call this to resolve a client_id before creating a project, expense '
      + 'or invoice, or when archiving.',
    inputSchema: {
      active: z
        .boolean()
        .default(true)
        .describe('When true (default) only active clients are returned. Set false for archived clients.'),
      limit,
      offset,
      verbose,
    },
    handler: (args: { active: boolean; limit: number; offset: number; verbose: boolean }, ctx) =>
      respond('list clients', async () => {
        const records = await ctx.client.clients(args.active);
        const filtered = records.map((record) => filterRecord(record, 'clientSummary', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_get_client: {
    level: 'read',
    description:
      'Fetch one Paymo client by id with its billing identity (fiscal_information) and contact '
      + 'details, to read before invoicing or updating.',
    inputSchema: { client_id: clientId, verbose },
    handler: (args: { client_id: number; verbose: boolean }, ctx) =>
      respond('get client', async () => {
        const record = await ctx.client.client(args.client_id);

        return filterRecord(record, 'client', args.verbose);
      }),
  },

  paymo_list_client_contacts: {
    level: 'read',
    description:
      'List Paymo client contacts, optionally for one client. Call this to reach a person at a '
      + 'client, not to find the client itself — that is paymo_list_clients.',
    inputSchema: {
      client_id: clientId.optional().describe('Restrict contacts to a single client.'),
      limit,
      offset,
      verbose,
    },
    handler: (args: { client_id?: number; limit: number; offset: number; verbose: boolean }, ctx) =>
      respond('list client contacts', async () => {
        const records = await ctx.client.clientContacts(args.client_id ?? null);
        const filtered = records.map((record) => filterRecord(record, 'clientContact', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_get_company: {
    level: 'read',
    description:
      'Return the company record for the Paymo account — the billing identity (name, address, '
      + 'fiscal_information) and defaults (currency, tax, invoice numbering) that invoices draw on.',
    inputSchema: { verbose },
    handler: (args: { verbose: boolean }, ctx) =>
      respond('get company', async () => {
        const company = await ctx.client.company();

        return filterRecord(company, 'company', args.verbose);
      }),
  },

  paymo_create_client: {
    level: 'write',
    description: 'Create a Paymo client. Requires a name; optionally set contact and billing details.',
    inputSchema: {
      name: z.string().max(255).describe('Client name.'),
      email: z.string().optional().describe('Client email.'),
      phone: z.string().optional().describe('Client phone number.'),
      fax: z.string().optional().describe('Client fax number.'),
      website: z.string().optional().describe('Client website URL.'),
      address: z.string().optional().describe('Street address.'),
      city: z.string().optional().describe('City.'),
      state: z.string().optional().describe('State or region.'),
      postal_code: z.string().optional().describe('Postal code.'),
      country: z.string().optional().describe('Country name or code.'),
      fiscal_information: z.string().optional().describe('Fiscal/legal info shown in invoice headers.'),
    },
    handler: (args: {
      name: string;
      email?: string;
      phone?: string;
      fax?: string;
      website?: string;
      address?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
      fiscal_information?: string;
    }, ctx) => {
      const payload: PaymoRecord = { name: args.name, ...collect(args, CLIENT_WRITE_FIELDS) };

      return respond('create client', () => ctx.client.createClient(payload));
    },
  },

  paymo_update_client: {
    level: 'write',
    description:
      'Update a Paymo client: any subset of the create fields, plus active. Archive a client by '
      + 'setting active to false — there is no separate archive tool. Deletion is deliberately '
      + 'not exposed (see the Clients section).',
    inputSchema: {
      client_id: clientId,
      name: z.string().optional().describe('New name.'),
      email: z.string().optional().describe('New email.'),
      phone: z.string().optional().describe('New phone.'),
      fax: z.string().optional().describe('New fax.'),
      website: z.string().optional().describe('New website.'),
      address: z.string().optional().describe('New street address.'),
      city: z.string().optional().describe('New city.'),
      state: z.string().optional().describe('New state or region.'),
      postal_code: z.string().optional().describe('New postal code.'),
      country: z.string().optional().describe('New country.'),
      fiscal_information: z.string().optional().describe('New fiscal/legal info for invoice headers.'),
      active: z.boolean().optional().describe('Set false to archive the client (there is no separate archive tool).'),
    },
    handler: (args: {
      client_id: number;
      name?: string;
      email?: string;
      phone?: string;
      fax?: string;
      website?: string;
      address?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
      fiscal_information?: string;
      active?: boolean;
    }, ctx) => {
      const payload = collect(args, [...CLIENT_WRITE_FIELDS, 'active'] as const);

      return respond('update client', () => ctx.client.updateClient(args.client_id, payload));
    },
  },

  paymo_create_client_contact: {
    level: 'write',
    description:
      'Add a contact to a Paymo client. Requires a name and a client_id. Grant the client portal '
      + 'by setting access true and a password.',
    inputSchema: {
      client_id: clientId,
      name: z.string().max(255).describe('Contact name.'),
      email: z.string().optional().describe('Contact email (used to log into the client portal).'),
      mobile: z.string().optional().describe('Mobile phone.'),
      phone: z.string().optional().describe('Phone number.'),
      fax: z.string().optional().describe('Fax number.'),
      skype: z.string().optional().describe('Skype account name.'),
      position: z.string().optional().describe('Job position, e.g. CEO.'),
      is_main: z.boolean().optional().describe('True to make this the main contact for the client.'),
      access: z.boolean().optional().describe('True to give this contact access to the client portal.'),
      password: z.string().optional().describe('Portal password. Only meaningful (and only accepted) when access is true.'),
      notes: z.string().optional().describe('Free-text notes about the contact.'),
    },
    handler: (args: {
      client_id: number;
      name: string;
      email?: string;
      mobile?: string;
      phone?: string;
      fax?: string;
      skype?: string;
      position?: string;
      is_main?: boolean;
      access?: boolean;
      password?: string;
      notes?: string;
    }, ctx) => {
      const payload: PaymoRecord = { client_id: args.client_id, name: args.name, ...collect(args, CONTACT_WRITE_FIELDS) };

      if (args.password !== undefined) {
        payload.password = args.password;
      }

      return respond('create client contact', () => ctx.client.createClientContact(payload));
    },
  },

  paymo_update_client_contact: {
    level: 'write',
    description:
      'Update a Paymo client contact: any subset of the create fields. Grant the client portal by '
      + 'setting access true and a password; revoke it with access false.',
    inputSchema: {
      contact_id: contactId,
      name: z.string().optional().describe('New name.'),
      email: z.string().optional().describe('New email.'),
      mobile: z.string().optional().describe('New mobile.'),
      phone: z.string().optional().describe('New phone.'),
      fax: z.string().optional().describe('New fax.'),
      skype: z.string().optional().describe('New skype.'),
      position: z.string().optional().describe('New job position.'),
      is_main: z.boolean().optional().describe('True to make this the main contact.'),
      access: z.boolean().optional().describe('True to give portal access, false to revoke it.'),
      password: z.string().optional().describe('Portal password. Only meaningful when access is being set to true.'),
      notes: z.string().optional().describe('New notes.'),
    },
    handler: (args: {
      contact_id: number;
      name?: string;
      email?: string;
      mobile?: string;
      phone?: string;
      fax?: string;
      skype?: string;
      position?: string;
      is_main?: boolean;
      access?: boolean;
      password?: string;
      notes?: string;
    }, ctx) => {
      const payload = collect(args, CONTACT_WRITE_FIELDS);

      if (args.password !== undefined) {
        payload.password = args.password;
      }

      return respond('update client contact', () => ctx.client.updateClientContact(args.contact_id, payload));
    },
  },
};