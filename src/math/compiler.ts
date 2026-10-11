// Compiles a list of expression lines (like Desmos' left panel) into one
// self-contained JavaScript program. Each line gets its own error state so a
// typo in one line never silences the others.

import { BUILTIN_FUNCS, CONSTANTS, RUNTIME_SRC, TIME_VARS } from './builtins';
import { lex, MathSyntaxError, splitWords, type Token } from './lexer';
import { Parser, type Cond, type Node } from './parser';

export type LineKind = 'empty' | 'note' | 'track' | 'slider' | 'const' | 'func' | 'value';

export interface LineInfo {
  kind: LineKind;
  error?: string;
  /** Undefined names; the UI offers to create sliders for them. */
  missing?: string[];
  /** Defined name, for slider / const / func lines. */
  name?: string;
  sliderValue?: number;
  /** Index into the instantiated program's `tracks`. */
  trackIndex?: number;
  /** Index into `values`, for lines that display a computed result. */
  valueIndex?: number;
}

export interface Program {
  lines: LineInfo[];
  /**
   * Body of `new Function('V', 'S', source)`. V maps slider names to values, and S
   * maps audio clip names to their samples. Neither is baked in, so dragging a
   * slider or loading a clip never changes the source.
   */
  source: string;
  /** Slider values as written in the text. */
  vars: Record<string, number>;
}

export interface Instance {
  tracks: ((t: number) => number)[];
  values: (() => number | number[])[];
}

type Type = 'num' | 'list';

/** One imported recording: mono samples at a known rate. */
export interface Sample {
  data: Float32Array;
  rate: number;
}

interface Def {
  /** -1 for audio clips, which have no line of text. */
  line: number;
  external?: boolean;
  kind: 'const' | 'func';
  name: string;
  params: string[];
  body: Node | null;
  deps: Set<string>;
  type?: Type;
}

const RESERVED = new Set([...Object.keys(BUILTIN_FUNCS), ...Object.keys(CONSTANTS), ...TIME_VARS, 'y']);

class CompileError extends Error {}

/** Split "lhs = rhs" at a top-level '=' (one inside {…} is a comparison). */
function splitEquals(tokens: Token[]): { lhs: Token[]; rhs: Token[] } | null {
  let depth = 0;
  let at = -1;
  tokens.forEach((t, i) => {
    if (t.type !== 'op') return;
    if ('([{'.includes(t.value)) depth++;
    else if (')]}'.includes(t.value)) depth--;
    else if (t.value === '=' && depth === 0) {
      if (at !== -1) throw new MathSyntaxError("Only one '=' is allowed per line");
      at = i;
    }
  });
  if (at === -1) return null;
  const end = tokens[tokens.length - 1];
  return { lhs: [...tokens.slice(0, at), end], rhs: tokens.slice(at + 1) };
}

interface Lhs {
  kind: 'track' | 'const' | 'func';
  name: string;
  params: string[];
}

function parseLhs(lhs: Token[]): Lhs {
  const words = lhs.filter((t) => t.type !== 'end');
  const checkName = (name: string, what: string) => {
    if (TIME_VARS.includes(name)) throw new CompileError(`${name} is time (in seconds) and can't be redefined`);
    if (RESERVED.has(name)) throw new CompileError(`'${name}' is built in and can't be used as a ${what}`);
  };
  if (words.length === 1 && words[0].type === 'word') {
    if (words[0].value === 'y') return { kind: 'track', name: 'y', params: [] };
    checkName(words[0].value, 'variable name');
    return { kind: 'const', name: words[0].value, params: [] };
  }
  // f(a, b, …)
  const ok =
    words.length >= 4 &&
    words[0].type === 'word' &&
    words[1].value === '(' &&
    words[words.length - 1].value === ')' &&
    words.slice(2, -1).every((t, i) => (i % 2 === 0 ? t.type === 'word' : t.value === ',')) &&
    words.length % 2 === 0;
  if (!ok) throw new CompileError('The left side should be y, a name like a, or a function like f(x)');
  const name = words[0].value;
  if (name === 'y') throw new CompileError('y is the output; write y = … instead');
  checkName(name, 'function name');
  const params = words.slice(2, -1).filter((t) => t.type === 'word').map((t) => t.value);
  for (const p of params) {
    if (RESERVED.has(p) && !TIME_VARS.includes(p)) throw new CompileError(`'${p}' is built in and can't be a parameter`);
  }
  if (new Set(params).size !== params.length) throw new CompileError('Parameters must have different names');
  return { kind: 'func', name, params };
}

interface Parsed {
  kind: LineKind;
  lhs?: Lhs;
  rhs?: Token[];
  ast?: Node;
}

/**
 * Compile the lines. `clips` names imported audio clips: each becomes a function of
 * one argument, clip(t), the recording's value t seconds in.
 */
export function compile(texts: string[], clips: string[] = []): Program {
  const lines: LineInfo[] = texts.map(() => ({ kind: 'empty' }));
  const parsed: Parsed[] = texts.map(() => ({ kind: 'empty' }));

  // Pass 1: lex, and find what each line defines.
  texts.forEach((text, i) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('//') || trimmed.startsWith('"')) {
      lines[i].kind = parsed[i].kind = 'note';
      return;
    }
    try {
      const tokens = lex(trimmed);
      const eq = splitEquals(tokens);
      if (!eq) {
        parsed[i] = { kind: 'value', rhs: tokens };
      } else {
        const lhs = parseLhs(eq.lhs);
        if (eq.rhs.length === 1) throw new CompileError('The right side is empty');
        parsed[i] = { kind: lhs.kind, lhs, rhs: eq.rhs };
        if (lhs.kind !== 'track') lines[i].name = lhs.name;
      }
      lines[i].kind = parsed[i].kind;
    } catch (e) {
      lines[i].kind = 'value';
      lines[i].error = (e as Error).message;
    }
  });

  // Gather definitions; duplicates are an error on every copy.
  const defs = new Map<string, Def>();
  const dupes = new Set<string>();
  for (const name of clips) {
    defs.set(name, { line: -1, external: true, kind: 'func', name, params: ['t'], body: null, deps: new Set(), type: 'num' });
  }
  parsed.forEach((p, i) => {
    if (lines[i].error || !p.lhs || p.lhs.kind === 'track') return;
    const { name } = p.lhs;
    if (defs.get(name)?.external) {
      lines[i].error = `'${name}' is the name of an audio clip`;
      return;
    }
    if (defs.has(name)) dupes.add(name);
    defs.set(name, { line: i, kind: p.lhs.kind as 'const' | 'func', name, params: p.lhs.params, body: null, deps: new Set() });
  });
  parsed.forEach((p, i) => {
    if (p.lhs && dupes.has(p.lhs.name)) lines[i].error = `'${p.lhs.name}' is defined more than once`;
  });
  for (const d of dupes) defs.delete(d);

  const isFunction = (name: string) => name in BUILTIN_FUNCS || defs.get(name)?.kind === 'func';

  // Pass 2: parse right-hand sides and collect references.
  const asts: (Node | null)[] = texts.map(() => null);
  const refs: Set<string>[] = texts.map(() => new Set());
  const usesTime: boolean[] = texts.map(() => false);
  parsed.forEach((p, i) => {
    if (lines[i].error || !p.rhs) return;
    const params = p.lhs?.kind === 'func' ? p.lhs.params : [];
    const known = (w: string) =>
      w in BUILTIN_FUNCS || w in CONSTANTS || defs.has(w) || TIME_VARS.includes(w) || params.includes(w);
    try {
      const ast = Parser.parse(splitWords(p.rhs, known), isFunction);
      asts[i] = ast;
      const missing = new Set<string>();
      walk(ast, (n) => {
        if (n.type === 'var') {
          if (params.includes(n.name) || n.name in CONSTANTS) return;
          if (TIME_VARS.includes(n.name)) {
            usesTime[i] = true;
            return;
          }
          const d = defs.get(n.name);
          if (!d) missing.add(n.name);
          else if (d.kind === 'func') throw new CompileError(`${n.name} is a function; call it like ${n.name}(x)`);
          else refs[i].add(n.name);
        } else if (n.type === 'call' && !(n.name in BUILTIN_FUNCS)) {
          refs[i].add(n.name);
        }
      });
      if (missing.size) {
        lines[i].missing = [...missing];
        throw new CompileError(`Not defined: ${[...missing].join(', ')}`);
      }
      if (usesTime[i]) {
        if (p.kind === 'const')
          throw new CompileError(
            `${p.lhs!.name} can't depend on time. Make it a function instead: ${p.lhs!.name}(x) = …`,
          );
        if (p.kind === 'func') throw new CompileError(`Add time as a parameter, like ${p.lhs!.name}(x) = …`);
        if (p.kind === 'value') lines[i].kind = 'track';
      }
      if (p.kind === 'const' && isNumberLiteral(ast)) {
        lines[i].kind = 'slider';
        lines[i].sliderValue = literalValue(ast);
      }
      const d = p.lhs && defs.get(p.lhs.name);
      if (d) {
        d.body = ast;
        d.deps = refs[i];
      }
    } catch (e) {
      if (!(e instanceof MathSyntaxError || e instanceof CompileError)) throw e;
      lines[i].error = e.message;
    }
  });

  // Pass 3: resolve definitions in dependency order, typecheck, and detect cycles.
  const state = new Map<string, 'visiting' | 'done'>();
  const good = new Map<string, boolean>();
  const order: Def[] = [];

  const checkDeps = (line: number, deps: Iterable<string>): boolean => {
    let ok = !lines[line].error;
    for (const dep of deps) {
      if (!resolve(dep) && !lines[line].error) {
        lines[line].error =
          state.get(dep) === 'visiting' ? 'Circular definition' : `Depends on '${dep}', which has an error`;
        ok = false;
      }
    }
    return ok;
  };

  const resolve = (name: string): boolean => {
    const d = defs.get(name);
    if (!d) return false;
    if (d.external) {
      if (!state.has(name)) {
        state.set(name, 'done');
        good.set(name, true);
        order.push(d);
      }
      return true;
    }
    const st = state.get(name);
    if (st === 'done') return good.get(name)!;
    if (st === 'visiting') return false;
    state.set(name, 'visiting');
    let ok = checkDeps(d.line, d.deps);
    if (ok) {
      try {
        const env = typeEnv(defs, d.params);
        d.type = typeOf(d.body!, env);
        if (d.kind === 'func' && d.type !== 'num') throw new CompileError('Functions must return a number');
      } catch (e) {
        if (!(e instanceof CompileError)) throw e;
        lines[d.line].error = e.message;
        ok = false;
      }
    }
    state.set(name, 'done');
    good.set(name, ok);
    if (ok) order.push(d);
    return ok;
  };
  for (const name of defs.keys()) resolve(name);

  // Pass 4: generate code.
  const out: string[] = ['"use strict";', RUNTIME_SRC];
  const vars: Record<string, number> = {};
  for (const d of order) {
    if (d.external) {
      out.push(`function u_${d.name}(p_t){return $sample(S[${JSON.stringify(d.name)}],p_t);}`);
      continue;
    }
    const line = lines[d.line];
    if (d.kind === 'func') {
      const params = d.params.map((p) => 'p_' + p).join(',');
      out.push(`function u_${d.name}(${params}){return ${gen(d.body!, d.params)};}`);
    } else if (line.kind === 'slider') {
      out.push(`const u_${d.name}=V["${d.name}"];`);
      vars[d.name] = line.sliderValue!;
    } else {
      out.push(`const u_${d.name}=${gen(d.body!, [])};`);
    }
  }

  const tracks: string[] = [];
  const values: string[] = [];
  lines.forEach((line, i) => {
    if (line.kind === 'const' && !line.error) {
      line.valueIndex = values.length;
      values.push(`()=>u_${line.name}`);
    }
    if ((line.kind !== 'track' && line.kind !== 'value') || line.error) return;
    if (!checkDeps(i, refs[i])) return;
    try {
      const type = typeOf(asts[i]!, typeEnv(defs, []));
      if (line.kind === 'track') {
        if (type !== 'num')
          throw new CompileError('A sound must be a single number at each moment; pick one item, like L[1]');
        line.trackIndex = tracks.length;
        tracks.push(`(T)=>${gen(asts[i]!, [])}`);
      } else {
        line.valueIndex = values.length;
        values.push(`()=>${gen(asts[i]!, [])}`);
      }
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      line.error = e.message;
    }
  });
  out.push(`return {tracks:[${tracks.join(',')}],values:[${values.join(',')}]};`);

  return { lines, source: out.join('\n'), vars };
}

export function instantiate(source: string, vars: Record<string, number>, samples: Record<string, Sample> = {}): Instance {
  return new Function('V', 'S', source)(vars, samples) as Instance;
}

function walk(n: Node, fn: (n: Node) => void): void {
  fn(n);
  switch (n.type) {
    case 'neg':
      return walk(n.arg, fn);
    case 'bin':
      walk(n.left, fn);
      return walk(n.right, fn);
    case 'call':
      return n.args.forEach((a) => walk(a, fn));
    case 'list':
      return n.items.forEach((a) => walk(a, fn));
    case 'index':
      walk(n.target, fn);
      return walk(n.index, fn);
    case 'piecewise':
      for (const b of n.branches) {
        b.cond.operands.forEach((a) => walk(a, fn));
        if (b.value) walk(b.value, fn);
      }
      if (n.otherwise) walk(n.otherwise, fn);
  }
}

function isNumberLiteral(n: Node): boolean {
  return n.type === 'num' || (n.type === 'neg' && n.arg.type === 'num');
}

function literalValue(n: Node): number {
  return n.type === 'num' ? n.value : n.type === 'neg' ? -literalValue(n.arg) : NaN;
}

interface TypeEnv {
  vars: (name: string) => Type;
  func: (name: string) => Def | undefined;
}

function typeEnv(defs: Map<string, Def>, params: string[]): TypeEnv {
  return {
    vars: (name) => (params.includes(name) ? 'num' : (defs.get(name)?.type ?? 'num')),
    func: (name) => defs.get(name),
  };
}

function typeOf(n: Node, env: TypeEnv): Type {
  const num = (child: Node, what: string) => {
    if (typeOf(child, env) !== 'num')
      throw new CompileError(`Lists can't be used in ${what} directly; pick an item like L[1]`);
  };
  switch (n.type) {
    case 'num':
      return 'num';
    case 'var':
      return env.vars(n.name);
    case 'neg':
      num(n.arg, 'arithmetic');
      return 'num';
    case 'bin':
      num(n.left, 'arithmetic');
      num(n.right, 'arithmetic');
      return 'num';
    case 'list':
      n.items.forEach((item) => {
        if (typeOf(item, env) !== 'num') throw new CompileError("Lists can't contain other lists");
      });
      return 'list';
    case 'index':
      if (typeOf(n.target, env) !== 'list') throw new CompileError('Only lists can be indexed with [ ]');
      num(n.index, 'an index');
      return 'num';
    case 'piecewise':
      for (const b of n.branches) {
        b.cond.operands.forEach((o) => num(o, 'a condition'));
        if (b.value) num(b.value, 'a piecewise');
      }
      if (n.otherwise) num(n.otherwise, 'a piecewise');
      return 'num';
    case 'call': {
      const builtin = BUILTIN_FUNCS[n.name];
      if (builtin) {
        const argTypes = n.args.map((a) => typeOf(a, env));
        if (n.args.length < builtin.minArgs || n.args.length > builtin.maxArgs)
          throw new CompileError(`${n.name} takes ${arityText(builtin.minArgs, builtin.maxArgs)}`);
        if (builtin.args === 'list') {
          if (argTypes[0] !== 'list') throw new CompileError(`${n.name} needs a list, like ${n.name}([1,2,3])`);
        } else if (builtin.args === 'numsOrList' && argTypes.length === 1 && argTypes[0] === 'list') {
          // min(L) is fine
        } else if (argTypes.some((t) => t !== 'num')) {
          throw new CompileError(`${n.name} needs numbers, not lists`);
        }
        return 'num';
      }
      const d = env.func(n.name)!;
      if (n.args.length !== d.params.length)
        throw new CompileError(`${n.name} takes ${arityText(d.params.length, d.params.length)}`);
      n.args.forEach((a) => num(a, `${n.name}'s arguments`));
      return 'num';
    }
  }
}

function arityText(min: number, max: number): string {
  const s = (k: number) => `${k} argument${k === 1 ? '' : 's'}`;
  if (min === max) return s(min);
  if (max === Infinity) return `at least ${s(min)}`;
  return `${min} to ${s(max)}`;
}

function gen(n: Node, params: string[]): string {
  const g = (c: Node) => gen(c, params);
  switch (n.type) {
    case 'num':
      return String(n.value);
    case 'var':
      if (params.includes(n.name)) return 'p_' + n.name;
      if (TIME_VARS.includes(n.name)) return 'T';
      if (n.name in CONSTANTS) return CONSTANTS[n.name];
      return 'u_' + n.name;
    case 'neg':
      return `(-${g(n.arg)})`;
    case 'bin':
      if (n.op === '^') return `$pow(${g(n.left)},${g(n.right)})`;
      return `(${g(n.left)}${n.op}${g(n.right)})`;
    case 'list':
      return `[${n.items.map(g).join(',')}]`;
    case 'index':
      return `$idx(${g(n.target)},${g(n.index)})`;
    case 'piecewise': {
      let code = n.otherwise ? g(n.otherwise) : 'NaN';
      for (let i = n.branches.length - 1; i >= 0; i--) {
        const b = n.branches[i];
        code = `(${genCond(b.cond, params)}?${b.value ? g(b.value) : '1'}:${code})`;
      }
      return code;
    }
    case 'call': {
      const builtin = BUILTIN_FUNCS[n.name];
      if (builtin) {
        if (builtin.args === 'numsOrList' && n.args.length === 1 && n.args[0].type !== 'num') {
          // Spread works for lists and is harmless for a single number wrapped in an array.
          return `${builtin.js}(...[].concat(${g(n.args[0])}))`;
        }
        return `${builtin.js}(${n.args.map(g).join(',')})`;
      }
      return `u_${n.name}(${n.args.map(g).join(',')})`;
    }
  }
}

function genCond(c: Cond, params: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < c.ops.length; i++) {
    const op = c.ops[i] === '=' ? '==' : c.ops[i];
    parts.push(`${gen(c.operands[i], params)}${op}${gen(c.operands[i + 1], params)}`);
  }
  return `(${parts.join('&&')})`;
}
