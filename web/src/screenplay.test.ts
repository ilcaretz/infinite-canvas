import { describe, expect, it } from 'vitest';
import { parseFountain } from './screenplay';

const types = (s: string) => parseFountain(s).map((e) => e.type);

describe('parseFountain', () => {
  const script = `Title: Test Film
Author: A. Writer

INT. KITCHEN - DAY

Anna enters, tired.
She sits.

ANNA
(whispering)
Morning.
Is anyone here?

CUT TO:

EXT. GARDEN - NIGHT

> THE END <
`;
  it('classifies title page, scene headings, action, character, parenthetical, dialogue, transition, centered', () => {
    expect(types(script)).toEqual([
      'title', 'title', 'scene', 'action', 'character', 'parenthetical', 'dialogue', 'dialogue', 'transition', 'scene', 'centered',
    ]);
  });
  it('merges action lines, uppercases scene headings, keeps dialogue text', () => {
    const els = parseFountain(script);
    expect(els[3].text).toBe('Anna enters, tired.\nShe sits.');
    expect(els[2].text).toBe('INT. KITCHEN - DAY');
    expect(els[4].text).toBe('ANNA');
    expect(els[6].text).toBe('Morning.');
  });
  it('supports forced elements and scene numbers', () => {
    const els = parseFountain('.the roof #12#\n\n@mcCoy\nHey.\n\n!SHOUT\n\n> FADE OUT.');
    expect(els.map((e) => e.type)).toEqual(['scene', 'character', 'dialogue', 'action', 'transition']);
    expect(els[0].text).toBe('THE ROOF');
    expect(els[1].text).toBe('mcCoy');
    expect(els[3].text).toBe('SHOUT');
  });
  it('ignores notes and boneyard, parses sections', () => {
    const els = parseFountain('# Act One\n\nHello [[note]] there /* gone */ now.');
    expect(els[0]).toEqual({ type: 'section', text: 'Act One', depth: 1 });
    expect(els[1].text).toBe('Hello  there  now.');
  });
  it('does not treat an upper-case line without dialogue below as a character', () => {
    expect(types('Before.\n\nSTOP\n\nAfter.')).toEqual(['action', 'action', 'action']);
  });
  it('handles CRLF and empty input', () => {
    expect(parseFountain('')).toEqual([]);
    expect(types('INT. A - DAY\r\n\r\nText.\r\n')).toEqual(['scene', 'action']);
  });
});
