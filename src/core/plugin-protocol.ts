/**
 * The contract between the studio and its plugins (Task.md 5), apiVersion 1.
 *
 * A plugin is an ES module that exports `manifest` and, for what it contributes,
 * `dataSources`, `actions`, `exporters`. It runs in a worker of its own; the page
 * talks to it in the messages below. Everything crossing that boundary is
 * structured-clone data: no functions, no class instances besides Blob.
 *
 * src/plugin-sdk/index.d.ts is what a plugin's author reads; tests/protocol.mjs
 * keeps the two in step.
 */
import type { AggregateQuery, Filter, Query, QueryResult, Row } from './query/types';

export const API_VERSIONS = [1] as const;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  author?: string;
  description?: string;
  homepage?: string;
  contributes: { dataSources?: string[]; actions?: string[]; exporters?: string[]; reports?: string[] };
  /**
   * `data: 'read'` — the plugin reads the application's records, read-only,
   * through `host.data`: shown to the person before they approve it.
   */
  permissions?: { hosts?: string[]; data?: 'read' };
}

export interface SettingDef {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'url' | 'password' | 'select' | 'file';
  title: string;
  description?: string;
  required?: boolean;
  /** Kept apart from the other settings, never exported, never shown again once entered. */
  secret?: boolean;
  default?: unknown;
  options?: { value: string; title: string }[];
}

export interface Capabilities {
  write: boolean;
  schema: 'managed' | 'external';
  query: { where: boolean; orderBy: boolean; paging: boolean; count: boolean; aggregate: boolean };
  batch: boolean;
  config: boolean;
  files: boolean;
  sequences: boolean;
  changes: boolean;
}

export const NO_CAPABILITIES: Capabilities = {
  write: false,
  schema: 'external',
  query: { where: false, orderBy: false, paging: false, count: false, aggregate: false },
  batch: false,
  config: false,
  files: false,
  sequences: false,
  changes: false,
};

/** Fills in what a plugin left out: a partial answer is read as "no". */
export function normalizeCapabilities(raw: unknown): Capabilities {
  const c = (raw ?? {}) as Partial<Capabilities> & { query?: Partial<Capabilities['query']> };
  const q: Partial<Capabilities['query']> = c.query ?? {};
  return {
    write: c.write === true,
    schema: c.schema === 'managed' ? 'managed' : 'external',
    query: { where: q.where === true, orderBy: q.orderBy === true, paging: q.paging === true, count: q.count === true, aggregate: q.aggregate === true },
    batch: c.batch === true,
    config: c.config === true,
    files: c.files === true,
    sequences: c.sequences === true,
    changes: c.changes === true,
  };
}

export interface ExternalField {
  name: string;
  type: string;
  title?: string;
  scale?: number;
  ref?: string;
}

export interface ExternalTable {
  name: string;
  title?: string;
  key?: string;
  fields: ExternalField[];
}

export type SchemaChange =
  | { op: 'createTable'; table: string }
  | { op: 'dropTable'; table: string }
  | { op: 'renameTable'; from: string; to: string }
  | { op: 'addField'; table: string; field: string; type: string }
  | { op: 'dropField'; table: string; field: string }
  | { op: 'renameField'; table: string; from: string; to: string }
  | { op: 'changeType'; table: string; field: string; from: string; to: string };

export type BatchOp =
  | { op: 'insert'; table: string; row: Row }
  | { op: 'update'; table: string; id: string; patch: Record<string, unknown>; expectedRev?: string }
  | { op: 'delete'; table: string; id: string; expectedRev?: string }
  /** Removes every row of `table` that matches `where` — a document's old register movements. */
  | { op: 'deleteWhere'; table: string; where: Filter };

export interface BatchResult {
  /** One per op: the written row for insert/update, null for delete. */
  results: (Row | null)[];
}

export interface FileRef {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface Change {
  table: string;
  id: string;
  op: 'insert' | 'update' | 'delete';
  row?: Row;
}

/** The methods a connection may answer; the page calls them by these names. */
export interface Connection {
  capabilities(): Capabilities | Promise<Capabilities>;
  describe?(): Promise<{ tables: ExternalTable[] }>;
  applySchema?(changes: SchemaChange[]): Promise<void>;
  loadConfig?(): Promise<{ doc: unknown; rev: string } | null>;
  saveConfig?(doc: unknown, expectedRev: string | null): Promise<{ rev: string }>;
  query(q: Query): Promise<QueryResult>;
  get?(table: string, id: string): Promise<Row | null>;
  insert?(table: string, row: Row): Promise<Row>;
  update?(table: string, id: string, patch: Record<string, unknown>, expectedRev?: string): Promise<Row>;
  delete?(table: string, id: string, expectedRev?: string): Promise<void>;
  batch?(ops: BatchOp[]): Promise<BatchResult>;
  aggregate?(q: AggregateQuery): Promise<{ rows: Record<string, unknown>[] }>;
  nextNumber?(sequence: string): Promise<number>;
  putFile?(blob: Blob, meta: { name: string; type: string }): Promise<FileRef>;
  getFile?(ref: FileRef): Promise<Blob>;
  close?(): Promise<void>;
}

export type ConnectionMethod = Exclude<keyof Connection, 'capabilities'> | 'capabilities';

export const CONNECTION_METHODS: readonly ConnectionMethod[] = [
  'capabilities',
  'describe',
  'applySchema',
  'loadConfig',
  'saveConfig',
  'query',
  'get',
  'insert',
  'update',
  'delete',
  'batch',
  'aggregate',
  'nextNumber',
  'putFile',
  'getFile',
  'close',
];

/**
 * The application's data, read-only, for a plugin approved to read it: rows
 * with their computed fields, a register's movements with the planned ones,
 * the configuration, an expression over no record.
 */
export interface PluginData {
  query(q: Query): Promise<QueryResult>;
  movements(register: string, to?: string | null, from?: string | null): Promise<Row[]>;
  config(): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
}

export const DATA_METHODS = ['query', 'movements', 'config', 'evaluate'] as const;

/** What a plugin's report gives back: columns, rows and, if it likes, a chart over them. */
export interface PluginReportResult {
  /** `total: false` — a number column whose sum means nothing (balances of different things). */
  columns: { key: string; title: string; type?: 'text' | 'number' | 'date' | 'datetime'; scale?: number; total?: boolean }[];
  rows: Record<string, unknown>[];
  chart?: { type: 'bar' | 'hbar' | 'stacked' | 'line' | 'area' | 'pie' | 'donut'; x: string; series: string[]; title?: string };
}

export interface ReportContribution {
  title: string;
  run(params: Record<string, unknown>, host: PluginHost): Promise<PluginReportResult>;
}

/** What the page gives a plugin, inside its worker. */
export interface PluginHost {
  /** Only for a plugin approved to read the application's data; its calls fail otherwise. */
  data: PluginData;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  settings: Record<string, unknown>;
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
  log(level: 'info' | 'warn' | 'error', message: string): void;
  progress(fraction: number | null, text?: string): void;
  emitChanges(changes: Change[]): void;
}

export interface DataSourceFactory {
  title: string;
  description?: string;
  settings?: SettingDef[];
  connect(settings: Record<string, unknown>, host: PluginHost): Promise<Connection>;
}

export interface ActionContribution {
  title: string;
  /** Returns structured-clone data; a Blob is offered to the user as a download. */
  run(args: Record<string, unknown>, host: PluginHost): Promise<unknown>;
}

export interface ExporterContribution {
  title: string;
  extension: string;
  export(input: { table: string; rows: Row[]; columns: { field: string; title: string }[] }, host: PluginHost): Promise<Blob>;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export type ErrorCode = 'conflict' | 'not_found' | 'validation' | 'auth' | 'forbidden' | 'network' | 'timeout' | 'unsupported' | 'internal';

const CODES = new Set<string>(['conflict', 'not_found', 'validation', 'auth', 'forbidden', 'network', 'timeout', 'unsupported', 'internal']);

/** A plugin throws one of these (or anything with a known `code`); the page shows a message per code. */
export class PluginError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
    if (details) this.details = details;
  }
}

export interface WireError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function toWireError(error: unknown): WireError {
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; message?: unknown; details?: unknown; name?: unknown };
    const message = typeof e.message === 'string' ? e.message : String(error);
    if (typeof e.code === 'string' && CODES.has(e.code)) {
      const details = e.details && typeof e.details === 'object' ? JSON.parse(JSON.stringify(e.details)) : undefined;
      return details ? { code: e.code as ErrorCode, message, details } : { code: e.code as ErrorCode, message };
    }
    // fetch() rejects with a TypeError when the network or CORS fails.
    if (e.name === 'TypeError' && /fetch|network/i.test(message)) return { code: 'network', message };
    return { code: 'internal', message };
  }
  return { code: 'internal', message: String(error) };
}

export function fromWireError(wire: WireError): PluginError {
  return new PluginError(wire.code, wire.message, wire.details);
}

/* ------------------------------------------------------------------ *
 * Messages between the page and a plugin's worker
 * ------------------------------------------------------------------ */

export type ToWorker =
  /** `hosts` null: the plugin is built in, its manifest's hosts are taken as they are. */
  | { kind: 'init'; id: number; code: string; hosts: string[] | null; pluginId: string; data?: boolean }
  | { kind: 'connect'; id: number; connection: string; source: string; settings: Record<string, unknown> }
  | { kind: 'call'; id: number; connection: string; method: string; args: unknown[] }
  | { kind: 'action'; id: number; action: string; args: Record<string, unknown> }
  | { kind: 'export'; id: number; exporter: string; input: unknown }
  | { kind: 'report'; id: number; report: string; params: Record<string, unknown> }
  /** The answer to a plugin's request for data. */
  | { kind: 'dataResult'; id: number; value?: unknown; error?: WireError }
  | { kind: 'disconnect'; id: number; connection: string };

export type FromWorker =
  | { kind: 'result'; id: number; value: unknown }
  | { kind: 'error'; id: number; error: WireError }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'progress'; fraction: number | null; text?: string }
  | { kind: 'changes'; connection: string; changes: Change[] }
  /** A plugin asks for the application's data; answered by 'dataResult' with the same id. */
  | { kind: 'data'; id: number; method: string; args: unknown[] };

/** What the worker answers to 'init': the manifest and what each contribution needs from the page. */
export interface PluginDescription {
  manifest: PluginManifest;
  dataSources: { name: string; title: string; description?: string; settings: SettingDef[] }[];
  actions: { name: string; title: string }[];
  exporters: { name: string; title: string; extension: string }[];
  reports?: { name: string; title: string }[];
}

/* ------------------------------------------------------------------ *
 * Manifests and hosts
 * ------------------------------------------------------------------ */

/** Problems with a manifest, in English for the plugin's author; empty when it is fine. */
export function checkManifest(raw: unknown): string[] {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') return ['The plugin exports no `manifest` object'];
  const m = raw as Partial<PluginManifest>;
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(m.id)) problems.push('manifest.id must be lowercase letters, digits and dashes');
  if (typeof m.name !== 'string' || !m.name.trim()) problems.push('manifest.name is required');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) problems.push('manifest.version must be x.y.z');
  if (typeof m.apiVersion !== 'number') problems.push('manifest.apiVersion is required');
  else if (!(API_VERSIONS as readonly number[]).includes(m.apiVersion)) problems.push(`apiVersion ${m.apiVersion} is not supported; this studio knows ${API_VERSIONS.join(', ')}`);
  if (!m.contributes || typeof m.contributes !== 'object') problems.push('manifest.contributes is required');
  if (m.permissions?.data !== undefined && m.permissions.data !== 'read') problems.push("manifest.permissions.data can only be 'read'");
  const hosts = m.permissions?.hosts ?? [];
  if (!Array.isArray(hosts)) problems.push('manifest.permissions.hosts must be a list');
  else for (const host of hosts) if (normalizeHost(host) === null) problems.push(`Not an origin: ${String(host)}`);
  return problems;
}

/**
 * 'https://api.example.com', 'https://*.example.com' (any subdomain),
 * 'http://localhost:8080' or 'http://localhost' (any port), or 'https://*'
 * (any host over https — for a source whose server the user types in).
 * Only the scheme, host and port count.
 */
export function normalizeHost(pattern: unknown): string | null {
  if (typeof pattern !== 'string') return null;
  const p = pattern.trim();
  const any = /^(https?):\/\/\*\/?$/i.exec(p);
  if (any) return `${any[1]!.toLowerCase()}://*`;
  const m = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)(:\d+)?\/?$/i.exec(p);
  if (!m) return null;
  return `${m[1]!.toLowerCase()}://${m[2] ?? ''}${m[3]!.toLowerCase()}${m[4] ?? ''}`;
}

export function hostAllowed(url: string, patterns: readonly string[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const scheme = target.protocol.slice(0, -1).toLowerCase();
  const hostname = target.hostname.toLowerCase();
  const port = target.port;
  for (const raw of patterns) {
    const pattern = normalizeHost(raw);
    if (!pattern) continue;
    const m = /^(https?):\/\/(\*\.)?([^:]*)(?::(\d+))?$/.exec(pattern)!;
    if (m[1] !== scheme) continue;
    if (m[3] === '*' && !m[2]) return true;
    if (m[4] !== undefined && m[4] !== port) continue;
    if (m[2] ? hostname === m[3] || hostname.endsWith(`.${m[3]}`) : hostname === m[3]) return true;
  }
  return false;
}
