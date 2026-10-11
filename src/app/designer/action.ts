/**
 * The action and trigger designer (Task.md 9.5): an action or a trigger is a
 * list of steps, shown numbered like "Actions for the item" of the old
 * configurator (core2.jpg). `if` steps hold two lists of their own, drawn
 * indented under them. The selected step is edited in the panel on the right;
 * with no step selected the panel shows the action's (or trigger's) own
 * properties. Every edit is one session change, so undo covers it.
 *
 * A step is addressed by its path through the lists: '2' is the third step,
 * '2/steps/0' the first step inside its "then", '2/else/1' the second of its
 * "else". Paths are recomputed after every structural edit.
 */
import { t } from '../../core/i18n';
import { checkExpr } from '../../core/expr/index';
import { HOST_FUNCTIONS } from '../../core/scope';
import { allFields, IDENT, newKey, normalizeHotkey, table as tableOf } from '../../core/config/model';
import type { ActionDef, Config, FieldDef, FieldType, FormNode, MenuNode, MenuTarget, Step, TableDef, TriggerDef, TriggerEvent } from '../../core/config/types';
import { button, clear, h, icon } from '../dom';
import { confirm, popupMenu, toast } from '../ui';
import type { Page } from '../app';
import type { Shell } from '../shell';
import { checkProp, exprProp, iconProp, section, selectProp, textProp, TYPE_OPTIONS, typeTitle } from './props';

type StepType = Step['type'];
type StepOf<T extends StepType> = Extract<Step, { type: T }>;
type Owner = ActionDef | TriggerDef;
type Kind = 'action' | 'trigger';

/** Functions the host adds to expressions (the same list the property controls check against). */
const HOST = Object.keys(HOST_FUNCTIONS);

const STEP_TYPES: StepType[] = ['ask', 'confirm', 'create', 'update', 'delete', 'open', 'post', 'unpost', 'fill', 'print', 'plugin', 'message', 'stop', 'if'];

function stepTitle(type: StepType): string {
  switch (type) {
    case 'ask':
      return t('actionDesigner', 'Ask for parameters');
    case 'confirm':
      return t('actionDesigner', 'Confirm');
    case 'create':
      return t('actionDesigner', 'Create a record');
    case 'update':
      return t('actionDesigner', 'Change records');
    case 'delete':
      return t('actionDesigner', 'Delete records');
    case 'open':
      return t('actionDesigner', 'Open');
    case 'post':
      return t('actionDesigner', 'Post');
    case 'unpost':
      return t('actionDesigner', 'Unpost');
    case 'fill':
      return t('actionDesigner', 'Fill the lines again');
    case 'print':
      return t('actionDesigner', 'Print');
    case 'plugin':
      return t('actionDesigner', 'Call a plugin');
    case 'message':
      return t('actionDesigner', 'Message');
    case 'stop':
      return t('actionDesigner', 'Stop');
    case 'if':
      return t('actionDesigner', 'If');
  }
}

function stepIcon(type: StepType): string {
  const icons: Record<StepType, string> = { ask: 'form', confirm: 'info', create: 'plus', update: 'edit', delete: 'trash', open: 'external', post: 'post', unpost: 'unpost', fill: 'refresh', print: 'print', plugin: 'puzzle', message: 'text', stop: 'x', if: 'tree' };
  return icons[type];
}

function targetTitle(target: 'current' | 'selected'): string {
  return target === 'selected' ? t('actionDesigner', 'the selected records') : t('actionDesigner', 'the current record');
}

function eventTitle(event: TriggerEvent): string {
  switch (event) {
    case 'beforeSave':
      return t('actionDesigner', 'Before saving');
    case 'afterSave':
      return t('actionDesigner', 'After saving');
    case 'beforeDelete':
      return t('actionDesigner', 'Before deleting');
    case 'afterDelete':
      return t('actionDesigner', 'After deleting');
    case 'onFieldChange':
      return t('actionDesigner', 'When a field changes');
    case 'onFormOpen':
      return t('actionDesigner', 'When the form opens');
  }
}

/* ------------------------------ step paths ------------------------------ */

/** The list a path points into and the index in it; `make` creates a missing "else" (only in a draft). */
function locate(root: Step[], path: string, make = false): { list: Step[]; index: number } | null {
  const parts = path.split('/');
  let list = root;
  for (let i = 0; i < parts.length - 1; i += 2) {
    const step = list[Number(parts[i])];
    if (!step || step.type !== 'if') return null;
    if (parts[i + 1] === 'else') {
      if (make) step.else ??= [];
      list = step.else ?? [];
    } else list = step.steps;
  }
  return { list, index: Number(parts[parts.length - 1]) };
}

function stepAt(root: Step[], path: string | null): Step | undefined {
  if (path === null) return undefined;
  const loc = locate(root, path);
  return loc ? loc.list[loc.index] : undefined;
}

/** '2/steps/0' → '2/steps'; '3' → ''. */
function prefixOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

function join(prefix: string, index: number): string {
  return prefix ? `${prefix}/${index}` : String(index);
}

function quote(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** A copy with fresh keys, so a duplicated ask keeps distinct field keys. */
function cloneStep(step: Step): Step {
  const copy = structuredClone(step);
  const rekey = (s: Step) => {
    if (s.type === 'ask') for (const f of s.fields) f.key = newKey('f');
    if (s.type === 'if') [...s.steps, ...(s.else ?? [])].forEach(rekey);
  };
  rekey(copy);
  return copy;
}

export class ActionDesigner implements Page {
  id: string;
  title: string;
  icon: string;
  readonly el: HTMLElement;
  private selected: string | null = null;
  private main: HTMLElement;
  private props: HTMLElement;
  private toolbar: HTMLElement;

  constructor(
    private readonly shell: Shell,
    private readonly kind: Kind,
    private readonly key: string,
  ) {
    this.id = `design:${kind}:${key}`;
    this.icon = kind === 'action' ? 'bolt' : 'history';
    this.title = '';
    this.toolbar = h('div', { class: 'toolbar' });
    this.main = h('div', { class: 'action-main' });
    this.props = h('div', { class: 'props' });
    this.el = h('div', { class: 'page action-designer' }, this.toolbar, h('div', { class: 'designer' }, h('div', { class: 'designer-main' }, this.main), this.props));
    this.render();
  }

  private owner(config: Config = this.shell.session.config): Owner | undefined {
    return this.kind === 'action' ? config.actions.find((a) => a.key === this.key) : config.triggers.find((tr) => tr.key === this.key);
  }

  /** The table whose record the steps work on. */
  private ownerTable(): TableDef | undefined {
    const o = this.owner();
    return o?.table ? tableOf(this.shell.session.config, o.table) : undefined;
  }

  /** Names an expression of a step may use: the fields of the record ($-names are always allowed). */
  private names = (): string[] => {
    const tb = this.ownerTable();
    return tb ? [...allFields(tb).map((f) => f.name), 'id'] : [];
  };

  configChanged(): void {
    if (!this.owner()) {
      this.shell.closePage(this.id);
      return;
    }
    if (this.selected !== null && !stepAt(this.owner()!.steps, this.selected)) this.selected = null;
    this.render();
  }

  onKey(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return false;
    if (this.selected === null || !this.main.contains(target)) return false;
    if (e.key === 'Delete') return void this.removeStep(this.selected), true;
    if (e.altKey && e.key === 'ArrowUp') return void this.moveStep(-1), true;
    if (e.altKey && e.key === 'ArrowDown') return void this.moveStep(1), true;
    return false;
  }

  /** Applies a change to this action or trigger in the draft configuration. */
  private change(fn: (o: Owner, c: Config) => void): Promise<void> {
    return this.shell.session
      .change((c) => {
        const o = this.owner(c);
        if (o) fn(o, c);
      })
      .then(() => undefined)
      .catch((e: unknown) => this.shell.fail(e));
  }

  private render(): void {
    const o = this.owner();
    if (!o) return;
    // Keep the focus where it was: the panel is rebuilt after each change, while the person tabs on.
    const focusables = () => [...this.el.querySelectorAll<HTMLElement>('.props input, .props select, .props textarea')];
    const active = document.activeElement as HTMLElement | null;
    const focusAt = active && this.props.contains(active) ? focusables().indexOf(active) : -1;
    this.title = this.kind === 'action' ? (o as ActionDef).title : ((o as TriggerDef).description || `${(o as TriggerDef).table}: ${eventTitle((o as TriggerDef).event)}`);
    this.shell.updateTab(this);
    this.renderToolbar(o);
    this.renderSteps(o);
    const step = stepAt(o.steps, this.selected);
    if (step && this.selected !== null) this.renderStepProps(step, this.selected);
    else if (this.kind === 'action') this.renderActionProps(o as ActionDef);
    else this.renderTriggerProps(o as TriggerDef);
    if (focusAt >= 0) focusables()[focusAt]?.focus();
  }

  private renderToolbar(o: Owner): void {
    const action = this.kind === 'action' ? (o as ActionDef) : null;
    clear(
      this.toolbar,
      icon(action ? (action.icon ?? 'bolt') : 'history'),
      h('span', { class: 'page-title' }, this.title),
      action ? h('span', { class: 'muted mono' }, action.name) : h('span', { class: 'muted' }, `${(o as TriggerDef).table} · ${eventTitle((o as TriggerDef).event)}`),
      h('span', { class: 'spacer' }),
      action && !action.table ? button(t('actionDesigner', 'Run'), { icon: 'play', onClick: () => void this.shell.runAction(action.name, {}) }) : null,
      button(t('actionDesigner', 'Delete'), { icon: 'trash', class: 'danger', onClick: () => void this.deleteOwner() }),
    );
  }

  /* ------------------------------ the step list ------------------------------ */

  private renderSteps(o: Owner): void {
    const sel = this.selected;
    const selStep = stepAt(o.steps, sel);
    const list = h('div', { class: 'steps', tabindex: 0 }, this.stepList(o.steps, ''));
    if (!o.steps.length) list.appendChild(h('div', { class: 'muted action-empty' }, this.kind === 'action' ? t('actionDesigner', 'No steps yet: an action does nothing until you add one.') : t('actionDesigner', 'No steps yet: add what should happen on this event.')));
    const loc = sel !== null ? locate(o.steps, sel) : null;
    clear(
      this.main,
      h(
        'div',
        { class: 'f-buttons action-buttons' },
        button(t('actionDesigner', 'Add a step'), {
          icon: 'plus',
          class: 'primary',
          onClick: (e) => {
            const prefix = sel !== null ? prefixOf(sel) : '';
            const at = loc ? loc.index + 1 : o.steps.length;
            this.addMenu(e.currentTarget as HTMLElement, prefix, at);
          },
        }),
        button(null, { icon: 'arrowUp', title: t('actionDesigner', 'Move up'), disabled: !selStep || !loc || loc.index === 0, onClick: () => void this.moveStep(-1) }),
        button(null, { icon: 'arrowDown', title: t('actionDesigner', 'Move down'), disabled: !selStep || !loc || loc.index >= loc.list.length - 1, onClick: () => void this.moveStep(1) }),
        button(t('actionDesigner', 'Duplicate'), { icon: 'copy', disabled: !selStep, onClick: () => void this.duplicateStep() }),
        button(t('actionDesigner', 'Remove'), { icon: 'trash', class: 'danger', disabled: !selStep, onClick: () => sel !== null && void this.removeStep(sel) }),
        h('span', { class: 'spacer' }),
        button(this.kind === 'action' ? t('actionDesigner', 'Action properties') : t('actionDesigner', 'Trigger properties'), { icon: 'settings', class: sel === null ? 'active' : '', onClick: () => ((this.selected = null), this.render()) }),
      ),
      list,
    );
  }

  private stepList(steps: Step[], prefix: string): HTMLElement[] {
    return steps.map((step, i) => {
      const path = join(prefix, i);
      const row = h(
        'div',
        { class: `step${path === this.selected ? ' selected' : ''}`, 'data-path': path, 'data-type': step.type },
        h('span', { class: 'n' }, String(i + 1)),
        h('span', { class: 'step-icon' }, icon(stepIcon(step.type), 14)),
        h('span', { class: 'kind' }, stepTitle(step.type)),
        h('span', { class: 'what' }, this.summary(step)),
      );
      row.addEventListener('click', () => {
        this.selected = path;
        this.render();
        this.el.querySelector<HTMLElement>('.steps')?.focus();
      });
      if (step.type !== 'if') return row;
      const branch = (label: string, branchSteps: Step[], key: 'steps' | 'else') =>
        h(
          'div',
          { class: 'step-branch' },
          h('div', { class: 'step-branch-head' }, h('span', null, label), h('button', { type: 'button', class: 'btn step-add', 'data-add': `${path}/${key}`, title: t('actionDesigner', 'Add a step here'), onclick: (e: MouseEvent) => this.addMenu(e.currentTarget as HTMLElement, `${path}/${key}`, branchSteps.length) }, icon('plus', 12), t('actionDesigner', 'step'))),
          ...this.stepList(branchSteps, `${path}/${key}`),
        );
      return h('div', { class: 'step-block' }, row, h('div', { class: 'step-children' }, branch(t('actionDesigner', 'Then'), step.steps, 'steps'), branch(t('actionDesigner', 'Otherwise'), step.else ?? [], 'else')));
    });
  }

  /** A one-line description of what a step does. */
  private summary(step: Step): string {
    const config = this.shell.session.config;
    const values = (v: Record<string, string>) => Object.entries(v).map(([k, e]) => `${k} = ${e}`).join(', ');
    switch (step.type) {
      case 'ask':
        return `${step.title ?? ''}${step.title ? ': ' : ''}${step.fields.map((f) => f.title ?? f.name).join(', ')}`;
      case 'confirm':
      case 'message':
      case 'stop':
        return quote(step.text);
      case 'create': {
        const target = tableOf(config, step.table);
        const v = values(step.values);
        return `${target?.title ?? step.table}${v ? ` ← ${v}` : ''}${step.open ? ` · ${t('actionDesigner', 'opens the card')}` : ''}`;
      }
      case 'update':
        return `${targetTitle(step.target)}: ${values(step.values) || '—'}`;
      case 'delete':
      case 'post':
      case 'unpost':
        return targetTitle(step.target);
      case 'fill': {
        const part = (this.ownerTable()?.parts ?? []).find((p) => p.name === step.part);
        return part?.title ?? step.part;
      }
      case 'open':
        return `${step.target.kind} ${step.target.name}${step.filter ? ` · ${step.filter}` : ''}`;
      case 'print':
        return config.printTemplates.find((p) => p.name === step.template)?.title ?? step.template;
      case 'plugin':
        return `${step.plugin || '?'} · ${step.action || '?'}(${Object.keys(step.args).join(', ')})`;
      case 'if':
        return step.when;
    }
  }

  private addMenu(anchor: HTMLElement, prefix: string, at: number): void {
    popupMenu(
      anchor,
      STEP_TYPES.map((type) => ({ label: stepTitle(type), icon: stepIcon(type), run: () => void this.addStep(type, prefix, at) })),
    );
  }

  private newStep(type: StepType): Step {
    const config = this.shell.session.config;
    const o = this.owner();
    const tb = this.ownerTable();
    const many: 'current' | 'selected' = this.kind === 'action' && (o as ActionDef | undefined)?.multi ? 'selected' : 'current';
    switch (type) {
      case 'ask':
        return { type, title: t('actionDesigner', 'Parameters'), fields: [{ key: newKey('f'), name: 'value', title: t('actionDesigner', 'Value'), type: 'string', required: true }] };
      case 'confirm':
        return { type, text: t('actionDesigner', 'Are you sure?') };
      case 'create':
        return { type, table: config.tables.find((x) => x.kind !== 'register')?.name ?? config.tables[0]?.name ?? '', values: {}, open: true };
      case 'update':
        return { type, target: many, values: {} };
      case 'delete':
      case 'post':
      case 'unpost':
        return { type, target: many };
      case 'fill':
        return { type, part: (tb?.parts ?? []).find((p) => p.fill)?.name ?? tb?.parts?.[0]?.name ?? '' };
      case 'open': {
        const v = config.views[0];
        return { type, target: v ? { kind: 'view', name: v.name } : { kind: 'table', name: config.tables[0]?.name ?? '' } };
      }
      case 'print':
        return { type, template: config.printTemplates.find((p) => p.table === tb?.name)?.name ?? config.printTemplates[0]?.name ?? '' };
      case 'plugin':
        return { type, plugin: '', action: '', args: {} };
      case 'message':
        return { type, text: t('actionDesigner', 'Done') };
      case 'stop':
        return { type, text: t('actionDesigner', 'Cannot be done') };
      case 'if':
        return { type, when: 'true', steps: [] };
    }
  }

  private async addStep(type: StepType, prefix: string, at: number): Promise<void> {
    const step = this.newStep(type);
    await this.change((o) => {
      const loc = locate(o.steps, join(prefix, at), true);
      loc?.list.splice(loc.index, 0, step);
    });
    this.selected = join(prefix, at);
    this.render();
  }

  private async moveStep(by: number): Promise<void> {
    const path = this.selected;
    if (path === null) return;
    const loc = locate(this.owner()?.steps ?? [], path);
    if (!loc) return;
    const to = loc.index + by;
    if (to < 0 || to >= loc.list.length) return;
    await this.change((o) => {
      const l = locate(o.steps, path);
      if (!l) return;
      const [s] = l.list.splice(l.index, 1);
      l.list.splice(to, 0, s!);
    });
    this.selected = join(prefixOf(path), to);
    this.render();
  }

  private async duplicateStep(): Promise<void> {
    const path = this.selected;
    if (path === null) return;
    await this.change((o) => {
      const l = locate(o.steps, path);
      const s = l?.list[l.index];
      if (l && s) l.list.splice(l.index + 1, 0, cloneStep(s));
    });
    const loc = locate(this.owner()?.steps ?? [], path);
    if (loc) this.selected = join(prefixOf(path), loc.index + 1);
    this.render();
  }

  private async removeStep(path: string): Promise<void> {
    await this.change((o) => {
      const l = locate(o.steps, path);
      if (!l) return;
      l.list.splice(l.index, 1);
      // An empty "else" is the same as none; keep the stored form tidy.
      if (path.includes('/')) {
        const parent = stepAt(o.steps, prefixOf(prefixOf(path)));
        if (parent?.type === 'if' && parent.else && !parent.else.length) delete parent.else;
      }
    });
    this.selected = null;
    this.render();
  }

  /* ------------------------------ step properties ------------------------------ */

  private renderStepProps(step: Step, path: string): void {
    const set = <T extends StepType>(type: T, fn: (s: StepOf<T>) => void) =>
      void this.change((o) => {
        const s = stepAt(o.steps, path);
        if (s && s.type === type) fn(s as StepOf<T>);
      });
    const config = this.shell.session.config;
    const tb = this.ownerTable();
    const targetSel = (s: StepOf<'update' | 'delete' | 'post' | 'unpost'>) =>
      selectProp<'current' | 'selected'>(t('actionDesigner', 'Records'), s.target, [['current', t('actionDesigner', 'The current record')], ['selected', t('actionDesigner', 'The selected records')]], (v) => set(s.type, (x) => (x.target = v)));
    const noTable = () => h('p', { class: 'muted prop-note' }, t('actionDesigner', 'The action has no table: this step does nothing until one is chosen in the action properties.'));
    const body: (Node | null)[] = [];
    switch (step.type) {
      case 'ask':
        body.push(textProp(t('actionDesigner', 'Dialog title'), step.title, (v) => set('ask', (x) => (v ? (x.title = v) : delete x.title))), this.askFields(step, path));
        break;
      case 'confirm':
        body.push(this.textOrExpr(t('actionDesigner', 'Question'), step.text, (v) => set('confirm', (x) => (x.text = v))));
        break;
      case 'message':
        body.push(this.textOrExpr(t('actionDesigner', 'Text'), step.text, (v) => set('message', (x) => (x.text = v))));
        break;
      case 'stop':
        body.push(
          this.textOrExpr(t('actionDesigner', 'Reason'), step.text, (v) => set('stop', (x) => (x.text = v))),
          h('p', { class: 'muted prop-note' }, t('actionDesigner', 'Ends the action here. In a “before saving” trigger the record is not saved and this text says why.')),
        );
        break;
      case 'create': {
        const target = tableOf(config, step.table);
        body.push(
          selectProp(t('actionDesigner', 'Table'), step.table, config.tables.map((x) => [x.name, x.title] as [string, string]), (v) => set('create', (x) => ((x.table = v), (x.values = {})))),
          checkProp(t('actionDesigner', 'Open the card'), step.open, (v) => set('create', (x) => (v ? (x.open = true) : delete x.open)), t('actionDesigner', 'The new record opens unsaved in its card; otherwise it is saved at once and its id is $lastId')),
        );
        if (target) {
          body.push(h('div', { class: 'prop-note muted' }, t('actionDesigner', 'Values of the new record — expressions over the current record; empty fields get their defaults.')));
          for (const f of allFields(target).filter((x) => !x.computed && x.readonly !== true && x.name !== 'isFolder')) {
            body.push(exprProp(`${f.title ?? f.name} (${f.name})`, step.values[f.name], this.names, (v) => set('create', (x) => (v ? (x.values[f.name] = v) : delete x.values[f.name])), { placeholder: f.type === 'ref' && f.ref === tb?.name ? 'id' : '' }));
          }
        }
        break;
      }
      case 'update':
        body.push(targetSel(step));
        if (!tb) body.push(noTable());
        else {
          body.push(h('div', { class: 'prop-note muted' }, t('actionDesigner', 'New values — expressions over each record; empty fields stay as they are.')));
          for (const f of allFields(tb).filter((x) => !x.computed && x.readonly !== true)) {
            body.push(exprProp(`${f.title ?? f.name} (${f.name})`, step.values[f.name], this.names, (v) => set('update', (x) => (v ? (x.values[f.name] = v) : delete x.values[f.name]))));
          }
        }
        break;
      case 'delete':
      case 'post':
      case 'unpost':
        body.push(targetSel(step));
        if (!tb) body.push(noTable());
        break;
      case 'fill': {
        const parts = (tb?.parts ?? []).filter((p) => p.fill);
        body.push(selectProp(t('actionDesigner', 'Part'), step.part, parts.map((p) => [p.name, p.title ?? p.name] as [string, string]), (v) => set('fill', (x) => (x.part = v)), true));
        if (!parts.length) body.push(h('p', { class: 'muted prop-note' }, t('actionDesigner', 'None of this table’s parts says where its lines come from (Designer → table → Parts → Filled from).')));
        break;
      }
      case 'open':
        body.push(...this.openProps(step, (fn) => set('open', fn)));
        break;
      case 'print': {
        const templates = config.printTemplates.filter((p) => !tb || p.table === tb.name);
        body.push(selectProp(t('actionDesigner', 'Template'), step.template, templates.map((p) => [p.name, p.title] as [string, string]), (v) => set('print', (x) => (x.template = v)), true));
        if (!templates.length) body.push(h('p', { class: 'muted prop-note' }, t('actionDesigner', 'This table has no print templates yet.')));
        if (!tb) body.push(noTable());
        break;
      }
      case 'plugin':
        body.push(...this.pluginProps(step, (fn) => set('plugin', fn)));
        break;
      case 'if':
        body.push(
          exprProp(t('actionDesigner', 'When'), step.when, this.names, (v) => set('if', (x) => (x.when = v || 'true')), { placeholder: "status = 'new'" }),
          h('p', { class: 'muted prop-note' }, t('actionDesigner', 'When it is true the steps under “Then” run, otherwise those under “Otherwise”.')),
        );
        break;
    }
    clear(
      this.props,
      section(
        `${stepTitle(step.type)} · ${t('actionDesigner', 'step {n}', { n: path.split('/').filter((_, i) => i % 2 === 0).map((x) => Number(x) + 1).join('.') })}`,
        selectProp<StepType>(t('actionDesigner', 'Kind'), step.type, STEP_TYPES.map((x) => [x, stepTitle(x)]), (v) =>
          void this.change((o) => {
            const l = locate(o.steps, path);
            if (!l) return;
            const old = l.list[l.index]!;
            const next = this.newStep(v);
            // Keep what carries over: the text of a message turned into a stop, the inner steps of an if.
            if ('text' in old && 'text' in next) next.text = old.text;
            if ('target' in old && 'target' in next && typeof old.target === 'string' && typeof next.target === 'string') next.target = old.target;
            l.list[l.index] = next;
          }),
        ),
        ...body,
      ),
    );
  }

  /** Plain text, or an expression when it starts with '=' (checked as typed). */
  private textOrExpr(label: string, value: string, set: (v: string) => void): HTMLElement {
    const input = h('textarea', { class: 'input', rows: 3, spellcheck: 'false' });
    input.value = value;
    input.dataset.prop = label;
    const error = h('div', { class: 'field-error' });
    const check = () => {
      const v = input.value.trim();
      const isExpr = v.startsWith('=');
      input.classList.toggle('expr-input', isExpr);
      const r = isExpr ? checkExpr(v.slice(1), this.names(), HOST) : {};
      error.textContent = r.error?.message ?? '';
      input.classList.toggle('invalid', !!r.error);
      return !r.error;
    };
    input.addEventListener('input', check);
    input.addEventListener('change', () => check() && set(input.value));
    check();
    return h('div', { class: 'prop stack', title: t('actionDesigner', 'Plain text, or an expression after “=”: =\'Total: \' + total') }, h('label', null, label), input, error, h('div', { class: 'muted prop-hint' }, t('actionDesigner', 'Text, or =expression')));
  }

  private askFields(step: StepOf<'ask'>, path: string): HTMLElement {
    const config = this.shell.session.config;
    const setField = (i: number, fn: (f: FieldDef) => void) =>
      void this.change((o) => {
        const s = stepAt(o.steps, path);
        if (s?.type === 'ask' && s.fields[i]) fn(s.fields[i]!);
      });
    const paramNames = () => step.fields.map((f) => f.name);
    const cards = step.fields.map((f, i) => {
      const name = h('input', { class: 'input mono', value: f.name, 'data-prop': 'name', title: t('actionDesigner', 'Name: $params.{name}', { name: f.name }) });
      name.addEventListener('change', () => {
        const v = name.value.trim();
        if (!IDENT.test(v)) return toast(t('actionDesigner', 'The name must be a Latin identifier'), 'error');
        setField(i, (x) => (x.name = v));
      });
      const title = h('input', { class: 'input', value: f.title ?? '', placeholder: t('actionDesigner', 'Title') });
      title.addEventListener('change', () => setField(i, (x) => (title.value.trim() ? (x.title = title.value.trim()) : delete x.title)));
      const type = h('select', { class: 'input' }, TYPE_OPTIONS.map(([v]) => h('option', { value: v }, typeTitle(v))));
      type.value = f.type;
      type.addEventListener('change', () =>
        setField(i, (x) => {
          x.type = type.value as FieldType;
          if (x.type === 'ref' && !x.ref) x.ref = config.tables[0]?.name ?? '';
          if (x.type === 'enum' && !x.enum && !x.options) x.enum = config.enums[0]?.name ?? '';
          if (x.type === 'decimal' && x.scale === undefined) x.scale = 2;
        }),
      );
      const required = h('input', { type: 'checkbox' });
      required.checked = f.required === true;
      required.addEventListener('change', () => setField(i, (x) => (required.checked ? (x.required = true) : delete x.required)));
      const def = h('input', { class: 'input mono', value: f.default ?? '', placeholder: t('actionDesigner', 'default: expression') });
      const defError = h('div', { class: 'field-error' });
      const checkDef = () => {
        const r = def.value.trim() ? checkExpr(def.value.trim(), paramNames(), HOST) : {};
        defError.textContent = r.error?.message ?? '';
        def.classList.toggle('invalid', !!r.error);
        return !r.error;
      };
      def.addEventListener('input', checkDef);
      def.addEventListener('change', () => checkDef() && setField(i, (x) => (def.value.trim() ? (x.default = def.value.trim()) : delete x.default)));
      checkDef();
      let extra: HTMLElement | null = null;
      if (f.type === 'ref') {
        extra = h('select', { class: 'input' }, config.tables.map((x) => h('option', { value: x.name }, x.title)));
        (extra as HTMLSelectElement).value = f.ref ?? '';
        extra.addEventListener('change', () => setField(i, (x) => (x.ref = (extra as HTMLSelectElement).value)));
      } else if (f.type === 'enum') {
        extra = h('select', { class: 'input' }, config.enums.map((e) => h('option', { value: e.name }, e.title ?? e.name)));
        (extra as HTMLSelectElement).value = f.enum ?? '';
        extra.addEventListener('change', () => setField(i, (x) => ((x.enum = (extra as HTMLSelectElement).value), delete x.options)));
      }
      return h(
        'div',
        { class: 'ask-field', 'data-field': f.name },
        h('div', { class: 'ask-row' }, name, title),
        h('div', { class: 'ask-row' }, type, h('label', { class: 'ask-req' }, required, t('actionDesigner', 'Required'))),
        extra ? h('div', { class: 'ask-row one' }, extra) : null,
        h('div', { class: 'ask-row one' }, def),
        defError,
        h(
          'div',
          { class: 'ask-tools' },
          button(null, { icon: 'arrowUp', title: t('actionDesigner', 'Move up'), disabled: i === 0, onClick: () => void this.change((o) => { const s = stepAt(o.steps, path); if (s?.type === 'ask') s.fields.splice(i - 1, 0, s.fields.splice(i, 1)[0]!); }) }),
          button(null, { icon: 'arrowDown', title: t('actionDesigner', 'Move down'), disabled: i === step.fields.length - 1, onClick: () => void this.change((o) => { const s = stepAt(o.steps, path); if (s?.type === 'ask') s.fields.splice(i + 1, 0, s.fields.splice(i, 1)[0]!); }) }),
          button(null, { icon: 'trash', class: 'danger', title: t('actionDesigner', 'Remove the field'), onClick: () => void this.change((o) => { const s = stepAt(o.steps, path); if (s?.type === 'ask') s.fields.splice(i, 1); }) }),
        ),
      );
    });
    return h(
      'div',
      { class: 'prop stack' },
      h('label', null, t('actionDesigner', 'Fields → $params')),
      h('div', { class: 'ask-fields' }, cards),
      button(t('actionDesigner', 'Add a field'), {
        icon: 'plus',
        onClick: () =>
          void this.change((o) => {
            const s = stepAt(o.steps, path);
            if (s?.type !== 'ask') return;
            let name = 'value';
            for (let n = 2; s.fields.some((f) => f.name === name); n++) name = `value${n}`;
            s.fields.push({ key: newKey('f'), name, title: t('actionDesigner', 'Value'), type: 'string' });
          }),
      }),
    );
  }

  private openProps(step: StepOf<'open'>, set: (fn: (s: StepOf<'open'>) => void) => void): HTMLElement[] {
    const config = this.shell.session.config;
    const choices = (kind: MenuTarget['kind']): [string, string][] => {
      switch (kind) {
        case 'view':
          return config.views.map((v) => [v.name, v.title]);
        case 'table':
          return config.tables.map((x) => [x.name, x.title]);
        case 'report':
          return config.reports.map((r) => [r.name, r.title]);
        case 'dashboard':
          return config.dashboards.map((d) => [d.name, d.title]);
        case 'action':
          return config.actions.filter((a) => a.key !== this.key).map((a) => [a.name, a.title]);
      }
    };
    const kinds: [MenuTarget['kind'], string][] = [
      ['view', t('actionDesigner', 'A view')],
      ['table', t('actionDesigner', 'A table')],
      ['report', t('actionDesigner', 'A report')],
      ['dashboard', t('actionDesigner', 'A dashboard')],
      ['action', t('actionDesigner', 'Another action')],
    ];
    return [
      selectProp<MenuTarget['kind']>(t('actionDesigner', 'Opens'), step.target.kind, kinds, (v) => set((x) => (x.target = { kind: v, name: choices(v)[0]?.[0] ?? '' } as MenuTarget))),
      selectProp(t('actionDesigner', 'Which'), step.target.name, choices(step.target.kind), (v) => set((x) => (x.target = { ...x.target, name: v }))),
      exprProp(t('actionDesigner', 'Filter'), step.filter, this.names, (v) => set((x) => (v ? (x.filter = v) : delete x.filter)), { placeholder: "'customer = ' + id" }),
    ];
  }

  private pluginProps(step: StepOf<'plugin'>, set: (fn: (s: StepOf<'plugin'>) => void) => void): HTMLElement[] {
    const plugins = [...this.shell.registry.plugins.values()].map((p) => [p.id, p.name ? `${p.name} (${p.id})` : p.id] as [string, string]);
    if (step.plugin && !plugins.some(([id]) => id === step.plugin)) plugins.push([step.plugin, step.plugin]);
    const rows = Object.entries(step.args).map(([key, expr]) => {
      const k = h('input', { class: 'input mono', value: key });
      k.addEventListener('change', () =>
        set((x) => {
          const v = k.value.trim();
          if (!v || v === key) return;
          // Rebuild to keep the order of the arguments.
          x.args = Object.fromEntries(Object.entries(x.args).map(([kk, e]) => [kk === key ? v : kk, e]));
        }),
      );
      return h(
        'div',
        { class: 'arg-row' },
        k,
        exprProp('', expr, this.names, (v) => set((x) => (x.args[key] = v || "''"))),
        button(null, { icon: 'x', title: t('actionDesigner', 'Remove the argument'), onClick: () => set((x) => delete x.args[key]) }),
      );
    });
    return [
      selectProp(t('actionDesigner', 'Plugin'), step.plugin, plugins, (v) => set((x) => (x.plugin = v)), true),
      textProp(t('actionDesigner', 'Plugin action'), step.action, (v) => set((x) => (x.action = v)), { mono: true, placeholder: 'export' }),
      h(
        'div',
        { class: 'prop stack' },
        h('label', null, t('actionDesigner', 'Arguments (name → expression)')),
        ...rows,
        button(t('actionDesigner', 'Add an argument'), {
          icon: 'plus',
          onClick: () =>
            set((x) => {
              let name = 'arg';
              for (let n = 2; name in x.args; n++) name = `arg${n}`;
              x.args[name] = 'id';
            }),
        }),
      ),
      h('p', { class: 'muted prop-note' }, t('actionDesigner', 'The result is $result for the steps after it.')),
    ];
  }

  /* ------------------------------ the action's and trigger's own properties ------------------------------ */

  private renderActionProps(a: ActionDef): void {
    const config = this.shell.session.config;
    const set = (fn: (x: ActionDef) => void) => void this.change((o) => fn(o as ActionDef));
    const where = (place: 'list' | 'card' | 'detail', label: string) =>
      checkProp(label, (a.where ?? ['list', 'card']).includes(place), (v) =>
        set((x) => {
          const now = new Set(x.where ?? ['list', 'card']);
          if (v) now.add(place);
          else now.delete(place);
          x.where = (['list', 'card', 'detail'] as const).filter((p) => now.has(p));
        }),
      );
    clear(
      this.props,
      section(
        t('actionDesigner', 'Action'),
        textProp(t('actionDesigner', 'Title'), a.title, (v) => set((x) => (x.title = v || x.title))),
        textProp(t('actionDesigner', 'Name'), a.name, (v) => void this.rename(a, v), { mono: true, hint: t('actionDesigner', 'Buttons and menu items call the action by it') }),
        iconProp(t('actionDesigner', 'Icon'), a.icon, (v) => set((x) => (x.icon = v))),
        selectProp(t('actionDesigner', 'Table'), a.table ?? '', config.tables.map((x) => [x.name, x.title] as [string, string]), (v) => set((x) => (v ? (x.table = v) : delete x.table)), true),
        !a.table ? h('p', { class: 'muted prop-note' }, t('actionDesigner', 'With no table the action works on nothing in particular: it runs from the menu or with “Run”.')) : null,
      ),
      section(
        t('actionDesigner', 'Where it is offered'),
        where('list', t('actionDesigner', 'In lists')),
        where('card', t('actionDesigner', 'In cards')),
        where('detail', t('actionDesigner', 'In detail tabs')),
        checkProp(t('actionDesigner', 'Several records'), a.multi, (v) => set((x) => (v ? (x.multi = true) : delete x.multi)), t('actionDesigner', 'Works on all the selected records, not only the current one')),
        exprProp(t('actionDesigner', 'Available when'), a.enabled, this.names, (v) => set((x) => (v ? (x.enabled = v) : delete x.enabled)), { placeholder: 'not posted', hint: t('actionDesigner', 'An expression over the current record; the action is disabled when it is false') }),
        textProp(t('actionDesigner', 'Shortcut'), a.hotkey, (v) => set((x) => (v ? (x.hotkey = normalizeHotkey(v) ?? v) : delete x.hotkey)), { mono: true, placeholder: 'R, Shift+N, Ctrl+Alt+R', hint: t('actionDesigner', 'In a list or card of its table; anywhere for an action of no table') }),
      ),
    );
  }

  private renderTriggerProps(tr: TriggerDef): void {
    const config = this.shell.session.config;
    const set = (fn: (x: TriggerDef) => void) => void this.change((o) => fn(o as TriggerDef));
    const tb = tableOf(config, tr.table);
    const events: TriggerEvent[] = ['beforeSave', 'afterSave', 'beforeDelete', 'afterDelete', 'onFieldChange', 'onFormOpen'];
    clear(
      this.props,
      section(
        t('actionDesigner', 'Trigger'),
        selectProp(t('actionDesigner', 'Table'), tr.table, config.tables.map((x) => [x.name, x.title] as [string, string]), (v) => set((x) => ((x.table = v), delete x.field))),
        selectProp<TriggerEvent>(t('actionDesigner', 'Event'), tr.event, events.map((e) => [e, eventTitle(e)]), (v) => set((x) => ((x.event = v), v !== 'onFieldChange' && delete x.field))),
        tr.event === 'onFieldChange' ? selectProp(t('actionDesigner', 'Field'), tr.field ?? '', (tb ? allFields(tb) : []).map((f) => [f.name, f.title ?? f.name] as [string, string]), (v) => set((x) => (v ? (x.field = v) : delete x.field)), true) : null,
        textProp(t('actionDesigner', 'Description'), tr.description, (v) => set((x) => (v ? (x.description = v) : delete x.description))),
        checkProp(t('actionDesigner', 'Active'), tr.active !== false, (v) => set((x) => (v ? delete x.active : (x.active = false)))),
        h(
          'p',
          { class: 'muted prop-note' },
          tr.event === 'beforeSave'
            ? t('actionDesigner', 'Runs before the record is written: “Change records” on the current record changes what is saved, “Stop” cancels the save with its text.')
            : tr.event === 'onFieldChange'
              ? t('actionDesigner', 'Runs in the open card when the field changes; the card’s record changes in place, nothing is saved.')
              : t('actionDesigner', '$previous is the record as it was before the change.'),
        ),
      ),
    );
  }

  /** Renames the action and every button, link and menu item that calls it. */
  private async rename(a: ActionDef, to: string): Promise<void> {
    const from = a.name;
    if (to === from) return;
    if (!IDENT.test(to)) return toast(t('actionDesigner', 'The name must be a Latin identifier'), 'error');
    if (this.shell.session.config.actions.some((x) => x.name === to)) return toast(t('actionDesigner', 'There is already an action named “{name}”', { name: to }), 'error');
    await this.change((o, c) => {
      (o as ActionDef).name = to;
      for (const v of c.views) if (v.actions) v.actions = v.actions.map((n) => (n === from ? to : n));
      const walkForm = (n: FormNode) => {
        if ((n.type === 'button' || n.type === 'link') && n.action === from) n.action = to;
        if ('children' in n) n.children.forEach(walkForm);
      };
      for (const f of c.forms) walkForm(f.layout);
      const walkMenu = (nodes: MenuNode[]) => {
        for (const n of nodes) {
          if (n.target?.kind === 'action' && n.target.name === from) n.target.name = to;
          if (n.children) walkMenu(n.children);
        }
      };
      walkMenu(c.menu);
      const walkSteps = (steps: Step[]) => {
        for (const s of steps) {
          if (s.type === 'open' && s.target.kind === 'action' && s.target.name === from) s.target.name = to;
          if (s.type === 'if') [s.steps, s.else ?? []].forEach(walkSteps);
        }
      };
      for (const x of [...c.actions, ...c.triggers]) walkSteps(x.steps);
    });
  }

  private async deleteOwner(): Promise<void> {
    const o = this.owner();
    if (!o) return;
    if (this.kind === 'trigger') {
      if (!(await confirm(t('actionDesigner', 'Delete the trigger'), t('actionDesigner', 'Delete the trigger “{title}”?', { title: this.title }), t('actionDesigner', 'Delete'), true))) return;
      await this.shell.session.change((c) => void (c.triggers = c.triggers.filter((x) => x.key !== this.key))).catch((e: unknown) => this.shell.fail(e));
      return;
    }
    const a = o as ActionDef;
    if (!(await confirm(t('actionDesigner', 'Delete the action'), t('actionDesigner', 'Delete “{title}”? Its buttons, links and menu items go too.', { title: a.title }), t('actionDesigner', 'Delete'), true))) return;
    await this.shell.session
      .change((c) => {
        c.actions = c.actions.filter((x) => x.key !== this.key);
        for (const v of c.views) if (v.actions) v.actions = v.actions.filter((n) => n !== a.name);
        const stripForm = (n: FormNode) => {
          if ('children' in n) {
            n.children = n.children.filter((ch) => !((ch.type === 'button' || ch.type === 'link') && ch.action === a.name));
            n.children.forEach(stripForm);
          }
        };
        for (const f of c.forms) stripForm(f.layout);
        const stripMenu = (nodes: MenuNode[]): MenuNode[] => nodes.filter((n) => !(n.target?.kind === 'action' && n.target.name === a.name)).map((n) => (n.children ? { ...n, children: stripMenu(n.children) } : n));
        c.menu = stripMenu(c.menu);
      })
      .catch((e: unknown) => this.shell.fail(e));
  }
}

