/** The studio's settings: theme, density, language, user name, version. */
import { LANGUAGES, t } from '../../core/i18n';
import { h } from '../dom';
import { dialog } from '../ui';
import { applyTheme, DISTRIBUTION, saveSettings, settings, type Settings } from '../settings';
import type { Shell } from '../shell';

export function openSettings(shell: Shell): void {
  const theme = h('select', { class: 'input', 'data-setting': 'theme' }, h('option', { value: 'system' }, t('settings', 'As in the system')), h('option', { value: 'light' }, t('settings', 'Light')), h('option', { value: 'dark' }, t('settings', 'Dark')));
  theme.value = settings.theme;
  theme.addEventListener('change', () => {
    settings.theme = theme.value as Settings['theme'];
    saveSettings();
    applyTheme();
  });
  const density = h('select', { class: 'input' }, h('option', { value: 'compact' }, t('settings', 'Compact')), h('option', { value: 'comfortable' }, t('settings', 'Comfortable')));
  density.value = settings.density;
  density.addEventListener('change', () => {
    settings.density = density.value as Settings['density'];
    saveSettings();
    applyTheme();
  });
  const language = h('select', { class: 'input', 'data-setting': 'language' }, h('option', { value: 'system' }, t('settings', 'As in the system')), Object.entries(LANGUAGES).map(([code, name]) => h('option', { value: code }, name)));
  language.value = settings.language;
  language.addEventListener('change', () => shell.setLanguage(language.value as Settings['language']));
  const user = h('input', { class: 'input', value: settings.user });
  user.addEventListener('change', () => {
    settings.user = user.value.trim() || 'admin';
    saveSettings();
  });
  // A distribution hides the designer; whoever wants to change the application can show it.
  const designer = h('input', { type: 'checkbox', 'data-setting': 'designer' });
  designer.checked = settings.designer;
  designer.addEventListener('change', () => {
    settings.designer = designer.checked;
    saveSettings();
    shell.designerChanged();
  });
  const row = (label: string, control: HTMLElement) => h('div', { class: 'prop', style: { gridTemplateColumns: '160px 1fr', padding: '5px 0' } }, h('label', null, label), control);
  void dialog({
    title: t('settings', 'Settings'),
    body: h(
      'div',
      { style: { minWidth: '420px' } },
      row(t('settings', 'Theme'), theme),
      row(t('settings', 'Density'), density),
      row(t('settings', 'Language'), language),
      row(t('settings', 'Your name'), user),
      DISTRIBUTION ? row(t('settings', 'Show the designer'), designer) : null,
      h('p', { class: 'muted', style: { fontSize: '12px', margin: '14px 0 0' } }, t('settings', 'Your name is recorded in the records you create and change. Settings live in this browser.')),
      h('p', { class: 'muted', style: { fontSize: '12px', margin: '6px 0 0' } }, `BAP Studio ${__APP_VERSION__}`),
    ),
    buttons: [{ label: t('dialog', 'Close'), value: undefined, primary: true }],
    cancel: undefined,
  });
}
