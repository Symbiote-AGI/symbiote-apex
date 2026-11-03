function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export const MINIMUM_SPEECH_CONFIDENCE = 0.65;

export function isSpeechConfidenceSufficient(confidence: number | undefined): boolean {
  return confidence === undefined || confidence >= MINIMUM_SPEECH_CONFIDENCE;
}

export function extractWakeCommand(transcript: string, agentName: string): string | null {
  const words = normalize(transcript).split(' ').filter(Boolean);
  const expectedNames = [normalize(agentName).replaceAll(' ', '')].filter(Boolean);
  if (!expectedNames.length) return null;

  for (let index = 0; index < words.length - 1; index++) {
    if (words[index] !== 'hey') continue;
    for (let length = 1; length <= Math.min(3, words.length - index - 1); length++) {
      const candidate = words.slice(index + 1, index + length + 1).join('');
      if (!expectedNames.some(expectedName => similarName(candidate, expectedName))) continue;
      const command = words.slice(index + length + 1).join(' ');
      return command === 'a' ? '' : command;
    }
  }
  return null;
}

export function splitTrailingSendCommand(transcript: string): { text: string; send: boolean } {
  const text = transcript.trim();
  const match = text.match(/^(.*?)(?:\s+|^)send[.!?,;:…]*$/i);
  if (!match) return { text, send: false };
  return { text: match[1].trim(), send: true };
}

function similarName(candidate: string, expected: string): boolean {
  if (candidate === expected) return true;
  if (candidate.length < 4 || expected.length < 4) return false;
  const distance = levenshteinDistance(candidate, expected);
  return distance <= Math.max(1, Math.floor(Math.max(candidate.length, expected.length) * 0.25));
}

function levenshteinDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[right.length];
}
