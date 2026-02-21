import assert from 'node:assert/strict';
import { checkContrast, parseColor, relativeLuminance } from '../src/shared/contrast.js';

function approx(actual, expected, epsilon = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `Expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

{
  const result = checkContrast('black', 'white');
  approx(result.ratio, 21, 0.001);
  assert.equal(result.aa, true);
  assert.equal(result.aaa, true);
}

{
  const result = checkContrast('white', 'white');
  approx(result.ratio, 1, 0.001);
  assert.equal(result.aa, false);
  assert.equal(result.aaLarge, false);
}

{
  const result = checkContrast('#777', 'white');
  approx(result.ratio, 4.48, 0.03);
  assert.equal(result.aaLarge, true);
  assert.equal(result.aa, false);
}

{
  assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('#11223344'), { r: 17, g: 34, b: 51, a: 68 / 255 });
  assert.deepEqual(parseColor('rgb(12, 34, 56)'), { r: 12, g: 34, b: 56, a: 1 });
  assert.deepEqual(parseColor('rgba(12, 34, 56, 0.25)'), { r: 12, g: 34, b: 56, a: 0.25 });
  assert.deepEqual(parseColor('orange'), { r: 255, g: 165, b: 0, a: 1 });
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
}

{
  approx(relativeLuminance(0, 0, 0), 0, 0.000001);
  approx(relativeLuminance(255, 255, 255), 1, 0.000001);
}

console.log('contrast.test.js passed');
