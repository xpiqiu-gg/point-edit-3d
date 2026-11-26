import type { Annotation } from './types';

export function referenceNumbers(text: string): number[] {
  return [...new Set(Array.from(text.matchAll(/[①-⑳]/g), m => m[0].codePointAt(0)! - 0x2460 + 1))];
}

/** Keep each existing reference attached to the same annotation when labels move. */
export function renumberAnnotations(remaining: Annotation[], previous: Annotation[]) {
  const nextById = new Map<string, number>();
  let number = 1;
  for (const note of [...remaining].reverse()) nextById.set(note.id, note.scope === 'viewport' ? 0 : number++);
  const oldByNumber = new Map<number, Annotation[]>();
  for (const note of previous) if (note.scope !== 'viewport' && note.number > 0) oldByNumber.set(note.number, [...(oldByNumber.get(note.number) || []), note]);
  const newNumbers = new Set([...nextById.values()].filter(n => n > 0));
  const changed = remaining.length !== previous.length || remaining.some(note => nextById.get(note.id) !== note.number);
  const annotations = remaining.map(note => {
    const text = changed ? note.text.replace(/[①-⑳]/g, symbol => {
      const oldNumber = symbol.codePointAt(0)! - 0x2460 + 1;
      const candidates = oldByNumber.get(oldNumber) || [];
      if (candidates.length > 1) return `〔批注 #${oldNumber} 编号有歧义〕`;
      if (!candidates.length) return newNumbers.has(oldNumber) ? `〔未找到批注 #${oldNumber}〕` : symbol;
      const newNumber = nextById.get(candidates[0].id);
      if (newNumber === undefined) return `〔已删除的批注 #${oldNumber}〕`;
      return newNumber <= 20 ? String.fromCodePoint(0x2460 + newNumber - 1) : `(${newNumber})`;
    }) : note.text;
    return {...note, number:nextById.get(note.id)!, text};
  });
  return {annotations, nextNumber:number};
}
