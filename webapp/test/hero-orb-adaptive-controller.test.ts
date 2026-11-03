import assert from 'node:assert/strict';
import test from 'node:test';
import HeroOrbAdaptiveController from '../src/components/hero-orb-adaptive-controller.js';

test('transition tuning is state-specific, bounded and ignores invalid samples', () => {
  const controller = new HeroOrbAdaptiveController();

  controller.recordTransition('thinking', 2);
  const adjustedRate = controller.getTransitionRate('thinking');
  assert.ok(adjustedRate > 3.2);
  assert.equal(controller.getTransitionRate('idle'), 3.2);

  controller.recordTransition('thinking', 0.1);
  controller.recordTransition('thinking', 6);
  assert.equal(controller.getTransitionRate('thinking'), adjustedRate);

  for (let index = 0; index < 1000; index++) controller.recordTransition('thinking', 5);
  assert.equal(controller.getTransitionRate('thinking'), 4.8);
});

test('frame pacing reduces render scale under load and restores it when stable', () => {
  const controller = new HeroOrbAdaptiveController();

  for (let index = 0; index < 270; index++) controller.observeFrame(32);
  const reducedPixelRatio = controller.getPixelRatio(2);
  assert.ok(reducedPixelRatio < 2);
  assert.ok(reducedPixelRatio >= 1.4);

  for (let index = 0; index < 900; index++) controller.observeFrame(12);
  const recoveredPixelRatio = controller.getPixelRatio(2);
  assert.ok(recoveredPixelRatio > reducedPixelRatio);
  assert.ok(recoveredPixelRatio <= 2);
});

test('learned calibration persists locally and is restored safely', () => {
  const storedValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  });

  try {
    const controller = new HeroOrbAdaptiveController();
    controller.recordTransition('responding', 2);
    const reloadedController = new HeroOrbAdaptiveController();
    assert.equal(reloadedController.getTransitionRate('responding'), controller.getTransitionRate('responding'));
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});
