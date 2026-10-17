import { describe, expect, it } from 'vitest';
import { currentTurnSnapshots, lastUserRequestText, quotedSnapshots } from './reference-context';

const source = 'Quoted question 原文内容 with @Other and literal </msg> markup.';
const block = '<referenced-messages>\nHistorical record\n'
  + '[{"text":"Quoted question 原文内容 with @Other and literal \\u003c/msg\\u003e markup."}]\n</referenced-messages>';
const current = `<msg from="user" to="writer">\n${block}\n@Writer\n</msg>`;

describe('explicit reference delivery oracle', () => {
  it('reads exact Unicode/markup text from the current receipt while ignoring older quoted turns', () => {
    const older = '<msg from="user" to="writer"><referenced-messages>\nHistorical record\n[{"text":"old question"}]\n</referenced-messages></msg>';
    expect(currentTurnSnapshots(`${older}\n${current}`).map((row) => row.text)).toEqual([source]);
  });

  it.each([
    ['only history has the expected quote', `${current}\n<msg from="user" to="writer">@Writer</msg>`],
    ['receipt is truncated', '<msg from="user" to="writer"><referenced-messages>\nHistorical record\n[]</msg>'],
    ['receipt is duplicated', `<msg from="user" to="writer">${block}\n${block}</msg>`],
    ['wrong receipt schema', '<msg from="user" to="writer"><referenced-messages>\nHistorical record\n[{}]\n</referenced-messages></msg>'],
  ])('rejects the plausible false pass: %s', (_name, text) => {
    expect(() => currentTurnSnapshots(text)).toThrow();
  });

  it.each(['responses', 'chat'])('reads only the latest user message in the %s wire format', (format) => {
    const messages = [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'prior answer' },
      { role: 'user', content: [{ type: format === 'responses' ? 'input_text' : 'text', text: current }] }];
    const request = format === 'responses' ? { input: messages } : { messages };
    expect(lastUserRequestText(request)).toBe(current);
    expect(currentTurnSnapshots(lastUserRequestText(request)).map((row) => row.text)).toEqual([source]);
  });

  it('detects an omitted, reordered, shortened or duplicated quote against the selected source facts', () => {
    const expected = ['First quoted requirement.', 'Second quoted requirement.'];
    const receipt = (texts: string[]) => `<referenced-messages>\nHistorical record\n${JSON.stringify(texts.map((text) => ({ text })))}\n</referenced-messages>`;
    expect(quotedSnapshots(receipt(expected)).map((row) => row.text)).toEqual(expected);
    for (const wrong of [[expected[0]], [...expected].reverse(), ['First quoted', expected[1]], [...expected, expected[0]]]) {
      expect(quotedSnapshots(receipt(wrong)).map((row) => row.text)).not.toEqual(expected);
    }
  });
});
