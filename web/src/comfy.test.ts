import { describe, expect, it } from 'vitest';
import { openResultText, workflowLabel } from './comfy';

describe('Open in ComfyUI toast text', () => {
  it('saved + copied', () => {
    expect(openResultText({ saved: true, path: 'Board/shot 1.json' }, true)).toBe(
      'Workflow saved in ComfyUI → Workflows › Board › shot 1 (also copied — Ctrl+V on the ComfyUI canvas)',
    );
  });
  it('saved but clipboard blocked: no copy hint', () => {
    expect(openResultText({ saved: true, path: 'Board/a.json' }, false)).toBe('Workflow saved in ComfyUI → Workflows › Board › a');
  });
  it('not running', () => {
    expect(openResultText({ saved: false, reason: 'x' }, true)).toBe("ComfyUI isn't running — workflow copied to clipboard");
    expect(openResultText({ saved: false, reason: 'x' }, false)).toContain('could not be copied');
  });
  it('download name', () => {
    expect(workflowLabel('ComfyUI_0001_.png')).toBe('ComfyUI_0001_');
    expect(workflowLabel('.png')).toBe('workflow');
  });
});
