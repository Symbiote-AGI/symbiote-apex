import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractWakeCommand,
  isSpeechConfidenceSufficient,
  splitTrailingSendCommand,
} from '../src/components/voice-wake-word.ts';

test('extracts a command after the configured wake phrase', () => {
  assert.equal(extractWakeCommand('Hey Symbiote, open Markets and check gold.', 'Symbiote'), 'open markets and check gold');
});

test('accepts a close local-recognition spelling of the agent name', () => {
  assert.equal(extractWakeCommand('hey symbiotic open my conversation', 'Symbiote'), 'open my conversation');
});

test('accepts Vosk spelling variation of the active agent name', () => {
  assert.equal(extractWakeCommand('hey symbionts', 'Symbiant'), '');
});

test('arms on a wake phrase without a command', () => {
  assert.equal(extractWakeCommand('Hey Agent', 'Agent'), '');
});

test('uses the active agent profile name as the only wake name', () => {
  assert.equal(extractWakeCommand('Hey Sirius', 'Sirius'), '');
  assert.equal(extractWakeCommand('Hey Symbiant', 'Sirius'), null);
  assert.equal(extractWakeCommand('Hey Sirius, open my conversation', 'Sirius'), 'open my conversation');
});

test('does not activate for unrelated speech', () => {
  assert.equal(extractWakeCommand('The agent should open Markets', 'Symbiote'), null);
});

test('recognizes send only as a trailing magic word', () => {
  assert.deepEqual(splitTrailingSendCommand('what is the weather send.'), {
    text: 'what is the weather',
    send: true,
  });
  assert.deepEqual(splitTrailingSendCommand('send me the weather'), {
    text: 'send me the weather',
    send: false,
  });
  assert.deepEqual(splitTrailingSendCommand('send'), { text: '', send: true });
});

test('rejects uncertain local recognition without blocking engines with no confidence score', () => {
  assert.equal(isSpeechConfidenceSufficient(0.55), false);
  assert.equal(isSpeechConfidenceSufficient(0.65), true);
  assert.equal(isSpeechConfidenceSufficient(undefined), true);
});
