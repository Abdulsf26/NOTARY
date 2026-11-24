// Notary — shared tokenisation (stop-words, synonyms, de-pluralisation).
// Extracted so bm25.js and similarity.js can share it without circular imports.
const STOP = new Set('a an the to of in on for with and or is are be by at as from that this it you your we can will would should into over under after before between across per each any all not no so such than then them there here when what which who whom how why'.split(' '));

// Intent synonyms: users say "find", tools say "search". Expand before matching.
const SYNONYMS = { find: 'search', locate: 'search', lookup: 'search', search: 'search', fetch: 'read', get: 'read', show: 'read', view: 'read', open: 'read', publish: 'post', broadcast: 'post', send: 'post', log: 'record', note: 'record', track: 'record', message: 'post', msg: 'post', doc: 'file', document: 'file', sheet: 'file', pdf: 'file' };

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_\s.]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^\.+|\.+$/g, ''))
    .filter(t => t.length > 1 && !STOP.has(t))
    .flatMap(t => {
      const forms = new Set([t]);
      if (t.endsWith('ing') && t.length > 5) forms.add(t.slice(0, -3));
      if (t.endsWith('ies') && t.length > 4) forms.add(t.slice(0, -3) + 'y');
      if (t.endsWith('es') && t.length > 4) forms.add(t.slice(0, -2));
      if (t.endsWith('s') && t.length > 3) forms.add(t.slice(0, -1));
      const out = [...forms];
      for (const f of forms) if (SYNONYMS[f]) out.push(SYNONYMS[f]);
      return out;
    });
}

const RAW_STOP = STOP;
/** Raw query tokens (pre-synonym/de-pluralised), used for name-hit features. */
export function rawTokens(text) {
  return [...new Set(String(text).toLowerCase().replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !RAW_STOP.has(t)))];
}
