/** How many words of a new recovery phrase must be typed back before the vault can be created. */
export const QUIZ_WORDS = 3;

/** `count` distinct word positions out of `total`, in ascending order, from the browser's CSPRNG. */
export function quizPositions(total: number, count = QUIZ_WORDS, random: (n: number) => number = secureBelow): number[] {
  const picked = new Set<number>();
  while (picked.size < Math.min(count, total)) picked.add(random(total));
  return [...picked].sort((a, b) => a - b);
}

/** True when every answer matches the phrase word at its position (case and surrounding space ignored). */
export function quizPassed(phrase: string, positions: number[], answers: string[]): boolean {
  const words = phrase.trim().toLowerCase().split(/\s+/);
  return positions.length > 0 && positions.every((p, i) => (answers[i] ?? '').trim().toLowerCase() === words[p]);
}

/** Uniform integer in [0, n) without modulo bias. */
function secureBelow(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}
