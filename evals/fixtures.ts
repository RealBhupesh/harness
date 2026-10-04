export type Benchmark = {
  id: string;
  goal: string;
  initial: string;
  solution: string;
  tests: string;
  oracle: string;
  refactor?: boolean;
  retry?: string;
  reference?: string;
  readRounds?: number;
};
const tests = (imports: string, assertions: string) =>
  `import {test} from 'node:test';import assert from 'node:assert/strict';import {${imports}} from './math.mjs';test('acceptance',()=>{${assertions}});`;
export const benchmarks: Benchmark[] = [
  {
    id: 'add-function',
    goal: 'Export add(a,b) from math.mjs. Preserve identity(x). Add works for positive, negative and zero operands.',
    initial: 'export const identity = (x) => x;\n',
    solution:
      'export const identity = (x) => x;\nexport const add = (a,b) => a+b;\n',
    tests: tests(
      'add,identity',
      "assert.equal(add(2,3),5);assert.equal(identity('x'),'x');",
    ),
    oracle:
      'assert.equal(module.add(-3,2),-1);assert.equal(module.add(0,0),0);assert.equal(module.identity(42),42);',
  },
  {
    id: 'fix-test',
    goal: 'Repair add(a,b) so the existing test passes and addition works for all finite numeric operands.',
    initial: 'export const add = (a,b) => a-b;\n',
    retry: 'export const add = (a,b) => a*b;\n',
    solution: 'export const add = (a,b) => a+b;\n',
    tests: tests('add', 'assert.equal(add(2,3),5);'),
    oracle:
      'assert.equal(module.add(-5,7),2);assert.equal(module.add(0,4),4);assert.equal(module.add(1.5,2.25),3.75);',
  },
  {
    id: 'refactor',
    goal: 'Refactor total(values) to use Array.reduce while preserving its sum behavior, including an empty array.',
    initial:
      'export function total(values){let sum=0;for(const value of values)sum+=value;return sum;}\n',
    solution:
      'export const total = (values) => values.reduce((sum,value)=>sum+value,0);\n',
    tests: tests(
      'total',
      'assert.equal(total([1,2,3]),6);assert.equal(total([]),0);',
    ),
    oracle:
      'assert.equal(module.total([-3,2,0]),-1);assert.equal(module.total([0.5,1.5]),2);assert.equal(module.total([]),0);',
    refactor: true,
  },
];

// Synthetic stress case measures repeated context cost, separately from general model capability.
benchmarks.push({
  ...benchmarks[0]!,
  id: 'long-context',
  goal: 'Read reference.txt for the existing API contract, then add add(a,b) while preserving identity(x).',
  reference:
    'Keep identity(x) and add numeric add(a,b).\n' +
    'Documentation background text.\n'.repeat(1000),
  readRounds: 8,
});
