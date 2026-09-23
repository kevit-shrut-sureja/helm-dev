#!/usr/bin/env node
// Boots the page's own modules in Node, against a running helm-dev, with just
// enough DOM for them to load. It answers the question a static check cannot:
// does the page still come up, with real data in it.
//
//   ./helm-dev &        (or an instance already running)
//   node smoke.mjs      prints what rendered, exits non-zero if it did not
//
// The DOM here is a stub, not an emulation: elements answer whatever is asked of
// them. That is enough to catch an unresolved import, a missing export or a
// boot-time throw, which is every way this page has actually broken.
const rendered = new Map();
const listeners = [];

const element = (id) =>
  new Proxy(
    { id, _html: '' },
    {
      get(target, prop) {
        if (prop === 'innerHTML' || prop === 'textContent') return target._html;
        if (prop === 'querySelectorAll') return () => [];
        if (prop === 'querySelector' || prop === 'closest') return () => null;
        if (prop === 'addEventListener') return (type) => listeners.push(`${id}:${type}`);
        if (prop === 'removeEventListener') return () => undefined;
        if (prop === 'contains') return () => false;
        if (prop === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
        if (prop === 'dataset') return {};
        if (prop === 'style') return { setProperty() {} };
        if (prop === 'focus' || prop === 'blur' || prop === 'click' || prop === 'append') return () => undefined;
        if (prop === 'scrollTop' || prop === 'scrollHeight' || prop === 'clientHeight' || prop === 'offsetHeight') return 600;
        if (prop === 'hidden' || prop === 'checked') return target[prop] ?? false;
        if (prop === 'value') return target.value ?? '';
        if (prop === 'title') return '';
        return target[prop];
      },
      set(target, prop, value) {
        if (prop === 'innerHTML' || prop === 'textContent') {
          target._html = value;
          rendered.set(id, String(value));
        }
        target[prop] = value;
        return true;
      },
    },
  );

const cache = new Map();
globalThis.document = {
  getElementById: (id) => (cache.has(id) ? cache.get(id) : (cache.set(id, element(id)), cache.get(id))),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (type) => listeners.push(`document:${type}`),
  createElement: (tag) => element(tag),
  body: element('body'),
  documentElement: element('html'),
};
globalThis.window = {
  addEventListener: (type) => listeners.push(`window:${type}`),
  removeEventListener: () => undefined,
  innerWidth: 1600,
  getSelection: () => ({ toString: () => '' }),
  location: { reload() {} },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => undefined } }, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.confirm = () => false;
globalThis.EventSource = class {
  constructor(url) { this.url = url; listeners.push(`sse:${url}`); }
  close() {}
};
const base = process.env.HELMDEV_URL ?? 'http://localhost:7788';
const realFetch = globalThis.fetch;
globalThis.fetch = (path, init) => realFetch(path.startsWith('http') ? path : base + path, init);

await import('/home/kevit/work/helm-dev/public/app.js');

const services = rendered.get('services') ?? '';
const stats = rendered.get('statsBar') ?? '';
const meta = rendered.get('indexMeta') ?? '';
const report = {
  modulesLoaded: true,
  serviceRows: (services.match(/class="service/g) ?? []).length,
  repoSections: (services.match(/repo-section/g) ?? []).length,
  statsRendered: stats.length > 0,
  indexMeta: meta,
  listeners: listeners.length,
  sse: listeners.filter((l) => l.startsWith('sse:')),
};
console.log(JSON.stringify(report, null, 2));

// A page that loads but renders nothing has failed in a way only this can see.
if (report.serviceRows === 0 || !report.statsRendered) {
  process.stderr.write('\nthe modules loaded but the page rendered nothing\n');
  process.exit(1);
}
