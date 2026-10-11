/**
 * What a screen may ask of the studio — open things, run actions, report —
 * without importing the shell (which imports every screen).
 */
import type { MenuTarget, TableDef, ActionDef } from '../core/config/types';
import type { ActionContext, ActionUI } from '../core/actions';
import type { DataService } from '../core/data';
import type { Filter, Row } from '../core/query/types';
import type { Session } from './session';

export interface Page {
  /** Unique: opening the same thing again shows this page instead of a second one. */
  id: string;
  title: string;
  icon?: string;
  el: HTMLElement;
  dirty?(): boolean;
  /** Asked before closing; false keeps the page open. */
  canClose?(): Promise<boolean>;
  onShow?(): void;
  dispose?(): void;
  /** The page's own shortcuts (Ctrl+S and the like); true when handled. */
  onKey?(e: KeyboardEvent): boolean;
  /** Runs an action of the page's table on its record or selection (a shortcut); false when it is not this page's. */
  hotkeyAction?(action: ActionDef): boolean;
}

export interface OpenOptions {
  filter?: Filter;
  title?: string;
  /** Fixed values for new records (a detail list creates records of its parent). */
  init?: Record<string, unknown>;
}

export interface App {
  session: Session;
  data: DataService;
  openTarget(target: MenuTarget, opts?: OpenOptions): void;
  openRecord(table: string, id: string | null, init?: Row | Record<string, unknown>, onSaved?: (row: Row) => void): void;
  openPage(page: Page): void;
  closePage(id: string): void;
  updateTab(page: Page): void;
  actionUI(): ActionUI;
  runAction(name: string, ctx: ActionContext): Promise<void>;
  /** Shows an error the way its kind deserves: validation, conflict, network… */
  fail(error: unknown, what?: string): void;
  status(text: string): void;
  /** Design mode helpers, offered from the running application. */
  designTable(table: string, field?: string): void;
  isDesign(): boolean;
  /** Exporters of the enabled plugins (Task.md 5.1): records → a file. */
  exporters(): Promise<{ plugin: string; name: string; title: string; extension: string }[]>;
  runExporter(plugin: string, name: string, input: { table: string; rows: Record<string, unknown>[]; columns: { field: string; title: string }[] }): Promise<void>;
  /** Opens a record selection dialog; resolves with the chosen rows. */
  choose(table: TableDef, opts?: { multi?: boolean; filter?: Filter }): Promise<Row[] | null>;
}
