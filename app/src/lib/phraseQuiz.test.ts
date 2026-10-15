import { describe, expect, it } from 'vitest';
import { quizPassed, quizPositions } from './phraseQuiz';

const PHRASE = `${'abandon '.repeat(23)}art`;

describe('phrase quiz', () => {
  it('picks distinct positions in range, sorted', () => {
    for (let i = 0; i < 200; i++) {
      const p = quizPositions(24);
      expect(p).toHaveLength(3);
      expect(new Set(p).size).toBe(3);
      expect(p.every((x) => Number.isInteger(x) && x >= 0 && x < 24)).toBe(true);
      expect([...p].sort((a, b) => a - b)).toEqual(p);
    }
  });

  it('passes only when every typed word matches its position', () => {
    expect(quizPassed(PHRASE, [0, 5, 23], ['abandon', 'abandon', 'art'])).toBe(true);
    expect(quizPassed(PHRASE, [0, 5, 23], ['  ABANDON ', 'Abandon', 'art '])).toBe(true);
    expect(quizPassed(PHRASE, [0, 5, 23], ['abandon', 'abandon', 'abandon'])).toBe(false);
    expect(quizPassed(PHRASE, [0, 5, 23], ['abandon', '', 'art'])).toBe(false);
    expect(quizPassed(PHRASE, [], [])).toBe(false);
  });
});
