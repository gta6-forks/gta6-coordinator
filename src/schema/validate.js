// Minimal JSON Schema subset validator (draft 2020-12 keywords used by this project only).
// Supported: type, enum, const, pattern, minLength, maxLength, minimum, maximum, required,
// properties, additionalProperties, items, minItems, maxItems, uniqueItems, $ref (#/$defs/...),
// oneOf, and the project keyword x-discriminator (picks the oneOf branch whose property is const).

function isType(t, v) {
  switch (t) {
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    default: return false;
  }
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => {
    if (!node || !(key in node)) throw new Error(`unresolved $ref ${ref}`);
    return node[key];
  }, root);
}

export function validate(schema, value) {
  const errors = [];
  const root = schema;

  function walk(s, v, p) {
    if (s === true || s === undefined) return;
    if (s === false) { errors.push(`${p}: not allowed`); return; }
    if (s.$ref) { walk(resolveRef(root, s.$ref), v, p); return; }

    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => isType(t, v))) { errors.push(`${p}: expected ${types.join('|')}`); return; }
    }
    if ('const' in s && v !== s.const) errors.push(`${p}: expected ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => e === v)) errors.push(`${p}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);

    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${p}: shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${p}: longer than ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${p}: does not match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${p}: below ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${p}: above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${p}: fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${p}: more than ${s.maxItems} items`);
      if (s.uniqueItems) {
        const seen = new Set(v.map((x) => JSON.stringify(x)));
        if (seen.size !== v.length) errors.push(`${p}: items must be unique`);
      }
      if (s.items) v.forEach((item, i) => walk(s.items, item, `${p}[${i}]`));
    }
    if (isType('object', v)) {
      for (const key of s.required || []) if (!(key in v)) errors.push(`${p}.${key}: required`);
      const props = s.properties || {};
      for (const [key, val] of Object.entries(v)) {
        if (key in props) walk(props[key], val, `${p}.${key}`);
        else if (s.additionalProperties === false) errors.push(`${p}.${key}: unknown property`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, val, `${p}.${key}`);
      }
    }
    if (s['x-discriminator']) {
      const key = s['x-discriminator'];
      const branch = (s.oneOf || []).find((b) => b.properties?.[key]?.const === v?.[key]);
      if (!branch) errors.push(`${p}.${key}: unknown value ${JSON.stringify(v?.[key])}`);
      else walk(branch, v, p);
    } else if (s.oneOf) {
      const passing = s.oneOf.filter((b) => validate({ ...root, ...b, $defs: root.$defs }, v).length === 0).length;
      if (passing !== 1) errors.push(`${p}: must match exactly one schema (matched ${passing})`);
    }
  }

  walk(schema, value, '$');
  return errors;
}
