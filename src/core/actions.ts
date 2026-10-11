/**
 * Runs actions and triggers (Task.md 9.5): a list of steps over the current
 * record or the selected ones. The steps that need a person — ask, confirm,
 * open, print — go through ActionUI, which the page implements; a trigger runs
 * with the UI the page registered, or none (then such steps are skipped).
 */
import { t } from './i18n';
import type { ActionDef, FieldDef, MenuTarget, Step, TableDef, TriggerDef } from './config/types';
import { NOWHERE, table as tableOf } from './config/model';
import { DataService, parseCached, truthy, ValidationError } from './data';
import { evaluate } from './expr/index';
import type { Row } from './query/types';

export interface ActionUI {
  ask(title: string, fields: FieldDef[]): Promise<Record<string, unknown> | null>;
  confirm(text: string): Promise<boolean>;
  message(text: string): void;
  openRecord(table: string, id: string): void;
  openNew(table: string, row: Row): void;
  open(target: MenuTarget, filter?: string): void;
  print(template: string, table: string, ids: string[]): void;
  runPlugin(plugin: string, action: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ActionContext {
  table?: TableDef;
  current?: Row | null;
  selected?: Row[];
  /** A trigger running before a save changes this record in place. */
  inPlace?: boolean;
  /** Values the steps read as `$name`: a dashboard widget's `$widget.value`. */
  vars?: Record<string, unknown>;
}

class Stop extends Error {}

export async function runAction(data: DataService, action: ActionDef, ctx: ActionContext, ui: ActionUI | null): Promise<boolean> {
  const tb = ctx.table ?? (action.table ? tableOf(data.config, action.table) : undefined);
  const vars: Record<string, unknown> = { ...(ctx.vars ?? {}), params: {}, selected: ctx.selected ?? [], lastId: null };
  try {
    await runSteps(data, action.steps, { ...ctx, ...(tb ? { table: tb } : {}) }, ui, vars);
    return true;
  } catch (error) {
    if (error instanceof Stop) {
      if (error.message) ui?.message(error.message);
      return false;
    }
    throw error;
  }
}

/** An action of no table still reads the constants, other tables and reports: over no record. */
async function value(data: DataService, tb: TableDef | undefined, row: Record<string, unknown>, source: string, vars: Record<string, unknown>): Promise<unknown> {
  const envOf = await data.scope(tb ?? NOWHERE, [source], vars);
  return evaluate(parseCached(source), envOf(row));
}

async function values(data: DataService, tb: TableDef | undefined, row: Record<string, unknown>, map: Record<string, string>, vars: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, source] of Object.entries(map)) out[k] = await value(data, tb, row, source, vars);
  return out;
}

async function runSteps(data: DataService, steps: Step[], ctx: ActionContext, ui: ActionUI | null, vars: Record<string, unknown>): Promise<void> {
  const tb = ctx.table;
  const current = ctx.current ?? null;
  const targets = (target: 'current' | 'selected'): Row[] => (target === 'selected' && ctx.selected?.length ? ctx.selected : current ? [current] : []);
  for (const step of steps) {
    switch (step.type) {
      case 'ask': {
        if (!ui) break;
        const answer = await ui.ask(step.title ?? t('actions', 'Parameters'), step.fields);
        if (!answer) throw new Stop('');
        vars.params = { ...(vars.params as object), ...answer };
        break;
      }
      case 'confirm': {
        if (!ui) break;
        const text = String(await value(data, tb, current ?? {}, quoteIfPlain(step.text), vars));
        if (!(await ui.confirm(text))) throw new Stop('');
        break;
      }
      case 'message': {
        const text = String(await value(data, tb, current ?? {}, quoteIfPlain(step.text), vars));
        ui?.message(text);
        break;
      }
      case 'stop': {
        const text = String(await value(data, tb, current ?? {}, quoteIfPlain(step.text), vars));
        if (ctx.inPlace) throw new ValidationError([{ message: text }]);
        throw new Stop(text);
      }
      case 'create': {
        const target = data.table(step.table);
        const init = await values(data, tb, current ?? {}, step.values, vars);
        const row = await data.newRecord(target, init, vars);
        if (step.open && ui) {
          // Not saved yet: the person finishes the record in its form and saves it there.
          ui.openNew(target.name, row);
        } else {
          const saved = await data.save(target, row, null);
          vars.lastId = saved.id;
        }
        break;
      }
      case 'update': {
        if (!tb) break;
        for (const row of targets(step.target)) {
          const patch = await values(data, tb, row, step.values, vars);
          if (ctx.inPlace && row === current) Object.assign(row, patch);
          else {
            const fresh = (await data.get(tb.name, row.id)) ?? row;
            await data.save(tb, { ...fresh, ...patch }, fresh);
          }
        }
        break;
      }
      case 'delete': {
        if (!tb) break;
        for (const row of targets(step.target)) await data.remove(tb, row);
        break;
      }
      case 'post':
      case 'unpost': {
        if (!tb) break;
        for (const row of targets(step.target)) {
          // The record a trigger is saving is changed in place; saving it again would run the trigger again.
          if (ctx.inPlace && row === current) {
            row.posted = step.type === 'post';
            continue;
          }
          const fresh = (await data.get(tb.name, row.id)) ?? row;
          await data.save(tb, { ...fresh, posted: step.type === 'post' }, fresh);
        }
        break;
      }
      case 'fill': {
        if (!tb || !current) break;
        // In a form (a trigger on a field) the lines change in place; otherwise the record is saved with them.
        if (ctx.inPlace) current[step.part] = await data.fillPart(tb, step.part, current);
        else {
          const fresh = (await data.get(tb.name, current.id)) ?? current;
          await data.save(tb, { ...fresh, [step.part]: await data.fillPart(tb, step.part, fresh) }, fresh);
        }
        break;
      }
      case 'open': {
        let filter: string | undefined;
        if (step.filter) filter = String(await value(data, tb, current ?? {}, step.filter, vars));
        ui?.open(step.target, filter);
        break;
      }
      case 'print': {
        if (!tb) break;
        ui?.print(step.template, tb.name, targets('selected').map((r) => r.id));
        break;
      }
      case 'plugin': {
        if (!ui) break;
        const args = await values(data, tb, current ?? {}, step.args, vars);
        vars.result = await ui.runPlugin(step.plugin, step.action, args);
        break;
      }
      case 'if': {
        const ok = truthy(await value(data, tb, current ?? {}, step.when, vars));
        await runSteps(data, ok ? step.steps : (step.else ?? []), ctx, ui, vars);
        break;
      }
    }
  }
}

/** Text fields of steps may be plain text or an expression; plain text is taken as a string. */
function quoteIfPlain(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('=')) return trimmed.slice(1);
  return `'${text.replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

let triggerUI: ActionUI | null = null;
let depth = 0;
const running = new Set<string>();

/** The page registers its UI so triggers can show messages and ask. */
export function setTriggerUI(ui: ActionUI): void {
  triggerUI = ui;
}

export function installTriggers(data: DataService): void {
  data.hooks.push(async (event, tb, row, previous) => {
    const triggers = data.config.triggers.filter((tr) => tr.table === tb.name && tr.event === event && tr.active !== false);
    if (!triggers.length) return;
    // A trigger saving the very record it runs for (an afterSave that updates it) would run itself
    // again on that save: the record's own triggers do not run while they are already running.
    const key = `${tb.name}:${row.id}`;
    if (running.has(key)) return;
    // A chain across records still has to end somewhere.
    if (depth >= 5) throw new ValidationError([{ message: t('actions', 'Triggers call each other too deep (more than 5 levels)') }]);
    depth++;
    running.add(key);
    try {
      // Before a save or a delete a `stop` refuses it: the caller is told why.
      for (const trigger of triggers) await runTrigger(data, trigger, tb, row, previous, event === 'beforeSave' || event === 'beforeDelete');
    } finally {
      depth--;
      running.delete(key);
    }
  });
}

async function runTrigger(data: DataService, trigger: TriggerDef, tb: TableDef, row: Row, previous: Row | null, inPlace: boolean): Promise<void> {
  const vars: Record<string, unknown> = { params: {}, previous, lastId: null };
  try {
    await runSteps(data, trigger.steps, { table: tb, current: row, selected: [row], inPlace }, triggerUI, vars);
  } catch (error) {
    if (error instanceof Stop) return;
    throw error;
  }
}

/** Runs the onFieldChange triggers of a form: the record changes in place, nothing is saved. */
export async function fieldChanged(data: DataService, tb: TableDef, row: Row, fieldName: string): Promise<void> {
  for (const trigger of data.config.triggers.filter((tr) => tr.table === tb.name && tr.event === 'onFieldChange' && tr.field === fieldName && tr.active !== false)) {
    await runTrigger(data, trigger, tb, row, null, true);
  }
}
