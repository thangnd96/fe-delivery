// Small JSON Schema validator covering the keywords used by fe-delivery schemas:
// type, required, properties, additionalProperties(boolean), items, enum, const,
// minimum, maximum, minLength, maxLength, pattern, $ref (#/$defs/..), allOf, if/then.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginRoot } from './paths.mjs';

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => (node ? node[key] : undefined), root);
}

function check(root, schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) {
    check(root, resolveRef(root, schema.$ref), value, path, errors);
    return;
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path || '/'}: expected ${schema.type}, got ${typeOf(value)}`);
    return;
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${path || '/'}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path || '/'}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: < ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: > ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => check(root, schema.items, item, `${path}/${i}`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path || '/'}: missing required "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) check(root, sub, value[key], `${path}/${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path || '/'}: unexpected property "${key}"`);
      }
    }
  }
  for (const sub of schema.allOf || []) {
    if (sub.if) {
      const probe = [];
      check(root, sub.if, value, path, probe);
      if (probe.length === 0 && sub.then) check(root, sub.then, value, path, errors);
    } else {
      check(root, sub, value, path, errors);
    }
  }
}

export function validate(schema, value) {
  const errors = [];
  check(schema, schema, value, '', errors);
  return errors;
}

export function loadSchema(name) {
  return JSON.parse(readFileSync(join(pluginRoot(), 'schemas', `${name}.schema.json`), 'utf8'));
}

export function validateNamed(name, value) {
  return validate(loadSchema(name), value);
}
