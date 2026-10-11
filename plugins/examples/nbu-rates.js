/**
 * Example of an external data source plugin: the official exchange rates of
 * the National Bank of Ukraine, read-only, fetched over HTTPS.
 *
 * Install: Plugins → Install from a file… → this file. Then Designer →
 * Connections → Add connection → "NBU exchange rates" → Import tables.
 *
 * It shows the minimum a data source needs: a manifest with the host it may
 * reach, describe() for its tables, and query(). Filtering and sorting are
 * left to the studio (capabilities say so).
 */
export const manifest = {
  id: 'nbu-rates',
  name: 'NBU exchange rates',
  version: '1.0.0',
  apiVersion: 1,
  author: 'BAP Studio examples',
  description: 'Official exchange rates of the National Bank of Ukraine (bank.gov.ua), read-only.',
  contributes: { dataSources: ['nbu'] },
  permissions: { hosts: ['https://bank.gov.ua'] },
};

const API = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange';

/** '09.10.2026' → '2026-10-09': the studio keeps dates as ISO strings. */
const isoDate = (d) => (/^(\d{2})\.(\d{2})\.(\d{4})$/.test(d) ? d.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1') : d);

export const dataSources = {
  nbu: {
    title: 'NBU exchange rates',
    description: 'Rates for a date (today when empty).',
    settings: [{ key: 'date', type: 'date', title: 'Rates for the date' }],
    async connect(settings, host) {
      let cache = null;
      const load = async () => {
        if (cache) return cache;
        const date = settings.date ? `&date=${String(settings.date).replaceAll('-', '')}` : '';
        const res = await host.fetch(`${API}?json${date}`);
        if (!res.ok) throw Object.assign(new Error(`NBU answered ${res.status}`), { code: 'network' });
        const list = await res.json();
        cache = list.map((r) => ({ id: r.cc, code: r.cc, numeric: r.r030, name: r.txt, rate: r.rate, date: isoDate(r.exchangedate) }));
        host.log('info', `${cache.length} rates loaded`);
        return cache;
      };
      return {
        capabilities: () => ({ write: false, schema: 'external', query: { where: false, orderBy: false, paging: false, count: false, aggregate: false } }),
        describe: async () => ({
          tables: [
            {
              name: 'NbuRates',
              title: 'Exchange rates (NBU)',
              key: 'code',
              fields: [
                { name: 'code', type: 'string', title: 'Code' },
                { name: 'numeric', type: 'integer', title: 'Numeric code' },
                { name: 'name', type: 'string', title: 'Currency' },
                { name: 'rate', type: 'decimal', scale: 4, title: 'Rate, UAH' },
                { name: 'date', type: 'date', title: 'Date' },
              ],
            },
          ],
        }),
        async query() {
          const rows = await load();
          return { rows, total: rows.length };
        },
        async get(_table, id) {
          return (await load()).find((r) => r.id === id) ?? null;
        },
      };
    },
  },
};
