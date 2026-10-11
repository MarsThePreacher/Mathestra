// Built-in functions and constants. The runtime source is inlined into every
// compiled program, so the exact same code runs for the graph and the audio thread.

export interface BuiltinFn {
  js: string;
  minArgs: number;
  maxArgs: number; // Infinity for variadic
  /** 'list' = takes one list; 'numsOrList' = numbers, or a single list that gets spread. */
  args: 'nums' | 'list' | 'numsOrList';
}

const n1 = (js: string): BuiltinFn => ({ js, minArgs: 1, maxArgs: 1, args: 'nums' });

export const BUILTIN_FUNCS: Record<string, BuiltinFn> = {
  sin: n1('$sin'),
  cos: n1('$cos'),
  tan: n1('$tan'),
  sec: n1('$sec'),
  csc: n1('$csc'),
  cot: n1('$cot'),
  arcsin: n1('$arcsin'),
  arccos: n1('$arccos'),
  arctan: { js: '$arctan', minArgs: 1, maxArgs: 2, args: 'nums' },
  asin: n1('$arcsin'),
  acos: n1('$arccos'),
  atan: { js: '$arctan', minArgs: 1, maxArgs: 2, args: 'nums' },
  sinh: n1('$sinh'),
  cosh: n1('$cosh'),
  tanh: n1('$tanh'),
  sqrt: n1('$sqrt'),
  cbrt: n1('$cbrt'),
  exp: n1('$exp'),
  ln: n1('$ln'),
  log: n1('$log'),
  abs: n1('$abs'),
  sign: n1('$sign'),
  sgn: n1('$sign'),
  floor: n1('$floor'),
  ceil: n1('$ceil'),
  round: n1('$round'),
  mod: { js: '$mod', minArgs: 2, maxArgs: 2, args: 'nums' },
  min: { js: '$min', minArgs: 1, maxArgs: Infinity, args: 'numsOrList' },
  max: { js: '$max', minArgs: 1, maxArgs: Infinity, args: 'numsOrList' },
  length: { js: '$length', minArgs: 1, maxArgs: 1, args: 'list' },
  total: { js: '$total', minArgs: 1, maxArgs: 1, args: 'list' },
  mean: { js: '$mean', minArgs: 1, maxArgs: 1, args: 'list' },
};

export const CONSTANTS: Record<string, string> = {
  pi: 'Math.PI',
  tau: '(2*Math.PI)',
  e: 'Math.E',
};

/** Names that mean "time in seconds" in a track. */
export const TIME_VARS = ['x', 't'];

export const RUNTIME_SRC = `
const $sin=Math.sin,$cos=Math.cos,$tan=Math.tan,
$sec=a=>1/Math.cos(a),$csc=a=>1/Math.sin(a),$cot=a=>1/Math.tan(a),
$arcsin=Math.asin,$arccos=Math.acos,
$arctan=(a,b)=>b===undefined?Math.atan(a):Math.atan2(a,b),
$sinh=Math.sinh,$cosh=Math.cosh,$tanh=Math.tanh,
$sqrt=Math.sqrt,$cbrt=Math.cbrt,$exp=Math.exp,$ln=Math.log,$log=Math.log10,
$abs=Math.abs,$sign=Math.sign,$floor=Math.floor,$ceil=Math.ceil,$round=Math.round,
$mod=(a,b)=>((a%b)+b)%b,$min=Math.min,$max=Math.max,$pow=Math.pow,
$length=L=>L.length,
$total=L=>{let s=0;for(let i=0;i<L.length;i++)s+=L[i];return s},
$mean=L=>L.length?$total(L)/L.length:NaN,
$idx=(L,i)=>{i=Math.floor(i);return i>=1&&i<=L.length?L[i-1]:NaN},
$sample=(b,t)=>{if(!b)return 0;const p=t*b.rate,d=b.data;if(!(p>=0))return 0;const i=Math.floor(p);if(i>=d.length-1)return i===d.length-1?d[i]:0;return d[i]+(d[i+1]-d[i])*(p-i)};
`;
