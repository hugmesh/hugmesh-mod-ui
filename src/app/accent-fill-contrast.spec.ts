/**
 * WCAG 1.4.3: text on an accent FILL must reach 4.5:1. --hug-text (#e8e8f0) on
 * --hug-accent (#7c4dff) is 3.94:1, and a live axe run flagged every such button.
 * Reads each component's compiled styles: any rule that fills with --hug-accent
 * must not paint its text with --hug-text, and its colour must read >= 4.5:1.
 */
import { FindingsPanelComponent } from './findings-panel.component';
import { ModerationConsoleComponent } from './moderation-console.component';

type RGB = [number, number, number];
const lum = ([r, g, b]: RGB): number => {
  const c = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const ratio = (a: RGB, b: RGB): number => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = (h: string): RGB => { const x = h.replace('#', ''); const f = x.length === 3 ? x.split('').map((ch) => ch + ch).join('') : x; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as RGB; };
const ACCENT = hex('#7c4dff');
/** What a var() paints in the shell: the token's shell value, else its literal fallback. */
const SHELL: Record<string, string> = { '--hug-text': '#e8e8f0', '--hug-accent-on': '#ffffff' };
function painted(value: string): string | null {
  const v = value.match(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)/);
  if (v) return SHELL[v[1]] ?? (v[2]?.trim().match(/^#[0-9a-fA-F]{3,6}$/) ? v[2].trim() : null);
  const h = value.trim().match(/^#[0-9a-fA-F]{3,6}$/);
  return h ? h[0] : null;
}

const COMPONENTS: Array<[string, unknown]> = [
  ['FindingsPanelComponent', FindingsPanelComponent],
  ['ModerationConsoleComponent', ModerationConsoleComponent],
];

describe('text on accent-filled controls (WCAG 1.4.3)', () => {
  for (const [name, cmp] of COMPONENTS) {
    it(`${name}: every --hug-accent fill carries text at >= 4.5:1`, () => {
      const css = ((cmp as { ɵcmp: { styles: string[] } }).ɵcmp.styles || []).join('\n')
        // Angular's compiled sheets carry a %NS% placeholder inside var() names.
        .replace(/%NS%/g, '');
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => /background(?:-color)?\s*:\s*var\(--hug-accent\s*[,)]/.test(m[2]))
        // A text-less decoration (an unread dot) sets no colour and has no text to
        // measure; every rule that DOES paint text on the fill is checked.
        .filter((m) => /(?:^|;)\s*color\s*:/.test(m[2]));
      expect(rules.length).withContext(`${name} has no accent-filled rule that paints text`).toBeGreaterThan(0);
      for (const m of rules) {
        const color = m[2].match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
        const fg = painted(color![1]);
        expect(fg).withContext(`${m[1].trim()}: cannot resolve ${color![1]}`).not.toBeNull();
        expect(ratio(hex(fg!), ACCENT)).withContext(`${m[1].trim()}: ${color![1]}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
