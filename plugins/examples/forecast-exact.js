/**
 * Example of a plugin that reads the application's data and computes a
 * report of its own: for the "Personal finances" template, when the money on
 * the accounts and personal money first reach zero — to the moment, as
 * Cashflow says it, where the template's reach() says the day.
 *
 * Install: Plugins → Install from a file… → this file (it asks to read the
 * application's records). Then Designer → Reports → a new report → "Computed
 * by" → "Forecast to the moment: When the money runs out".
 *
 * It shows what such a plugin needs: `permissions.data: 'read'` in the
 * manifest, `host.data` to read (query, movements with the planned ones,
 * evaluate), and a report that returns columns and rows. It never writes.
 */
export const manifest = {
  id: 'forecast-exact',
  name: 'Forecast to the moment',
  version: '1.0.0',
  apiVersion: 1,
  author: 'BAP Studio examples',
  description: 'When the money runs out, to the moment, for the Personal finances template. Reads the application’s records; changes nothing.',
  contributes: { reports: ['lastsUntil'] },
  permissions: { data: 'read' },
};

export const reports = {
  lastsUntil: {
    title: 'When the money runs out',
    async run(params, host) {
      const now = await host.data.evaluate('now()');
      const until = await host.data.evaluate("addYears(now(), coalesce($const.horizonYears, 5))");
      const kinds = new Map((await host.data.query({ table: 'Accounts' })).rows.map((a) => [a.id, a.kind]));
      // Every movement up to the horizon, the planned ones included, each with its worth in the base currency.
      const moves = (await host.data.movements('Money', until)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      let personal = 0;
      let assets = 0;
      let i = 0;
      const add = (m) => {
        personal += m.worth || 0;
        if (kinds.get(m.account) !== 'debt') assets += m.worth || 0;
      };
      while (i < moves.length && String(moves[i].date) <= now) add(moves[i++]);
      const at = { personal: personal <= 0 ? now : null, assets: assets <= 0 ? now : null };
      const start = { personal, assets };
      // Movements at one moment count together: a salary and a rent paid at once cancel before anything is looked at.
      while (i < moves.length && (!at.personal || !at.assets)) {
        const moment = String(moves[i].date);
        while (i < moves.length && String(moves[i].date) === moment) add(moves[i++]);
        if (!at.assets && assets <= 0) at.assets = moment;
        if (!at.personal && personal <= 0) at.personal = moment;
      }
      host.log('info', `Read ${moves.length} movements up to ${until}`);
      return {
        columns: [
          { key: 'what', title: 'What', type: 'text' },
          { key: 'now', title: 'Now', type: 'number', scale: 2, total: false },
          { key: 'when', title: 'Reaches zero', type: 'datetime' },
        ],
        rows: [
          { what: 'On the accounts', now: Math.round(start.assets * 100) / 100, when: at.assets },
          { what: 'Personal money', now: Math.round(start.personal * 100) / 100, when: at.personal },
        ],
      };
    },
  },
};
