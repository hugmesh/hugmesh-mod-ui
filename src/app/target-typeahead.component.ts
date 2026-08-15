import {
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ModDirectoryService, ModTargetSuggestion } from './mod-directory.service';

/**
 * The moderation console's target picker — a WAI-ARIA APG **combobox with a listbox popup**,
 * replacing the bare free-text boxes in which a moderator had to retype a full
 * {@code @user:instance.example} from memory.
 *
 * <h3>Hand-rolled, deliberately</h3>
 * This repo has no component library (package.json is Angular core/forms/router plus the
 * generated API client), and pulling one in for a single control would be a large new
 * dependency for a small widget. The ARIA contract is therefore written out explicitly.
 *
 * <h3>The ARIA contract (APG combobox, manual selection)</h3>
 * <ul>
 *   <li>The input is {@code role=combobox} with {@code aria-expanded},
 *       {@code aria-controls} → the listbox, and {@code aria-activedescendant} → the
 *       highlighted option. DOM focus never leaves the input, so the moderator keeps typing
 *       while arrowing.</li>
 *   <li>The popup is a {@code role=listbox} of {@code role=option} rows with
 *       {@code aria-selected} on the active one.</li>
 *   <li>ArrowDown/ArrowUp move (and open), Enter commits, Escape closes without changing the
 *       value, Tab leaves without committing.</li>
 *   <li>A {@code role=status} region announces the count / "keep typing" / "no matches"
 *       states.</li>
 * </ul>
 *
 * <h3>Free text is always still allowed</h3>
 * Suggestions come from {@link ModDirectoryService}, i.e. accounts already visible in this
 * moderator's own domain-scoped queues. A moderator must be able to act on a REMOTE account
 * that has never appeared in them — so the bound value is simply whatever is typed, and
 * picking a suggestion only fills it in.
 *
 * <p>Debounced even though the lookup is local: the field must not re-render its popup on
 * every keystroke while someone types a long mxid, and keeping the timing identical to the
 * admin console's picker keeps the two consoles feeling like one product.
 */
@Component({
  selector: 'hug-target-typeahead',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './target-typeahead.component.html',
  styleUrl: './target-typeahead.component.scss',
})
export class TargetTypeaheadComponent {
  private readonly directory = inject(ModDirectoryService);
  private readonly destroyRef = inject(DestroyRef);

  /** Debounce window — matched to admin-ui's picker so both consoles feel the same. */
  static readonly DEBOUNCE_MS = 250;
  /** Minimum query length before suggesting anything. */
  static readonly MIN_QUERY = 2;
  /** Maximum suggestions rendered. */
  static readonly PAGE_SIZE = 8;

  /** DOM id of the input — the caller's `<label for>` target; unique per instance. */
  @Input({ required: true }) inputId!: string;
  /** `data-testid` on the input, so existing per-form test hooks survive the swap. */
  @Input() testId = '';
  /** `name` attribute — the console's forms are ngForm-based and rely on it. */
  @Input() name = 'target';
  /** Placeholder shown in the empty input. */
  @Input() placeholder = '';
  /** Space-separated ids appended to the control's own describedby chain. */
  @Input() describedBy = '';
  /** Mirrors the caller's validation state onto the input. */
  @Input() invalid = false;
  /** The current value (two-way bound via `value` / `valueChange`). */
  @Input() value = '';
  /** Emitted on every keystroke AND on commit — the `[(value)]` half. */
  @Output() valueChange = new EventEmitter<string>();

  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('input');

  /** The current suggestion list. */
  readonly options = signal<ModTargetSuggestion[]>([]);
  /** Whether the listbox popup is rendered. */
  readonly open = signal(false);
  /** Index of the active (aria-activedescendant) option, or -1. */
  readonly activeIndex = signal(-1);
  /** True once a search has run for the current query and matched nothing. */
  readonly noMatches = signal(false);

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // A pending timer that outlived the component would write to a destroyed view.
    this.destroyRef.onDestroy(() => this.cancelPending());
  }

  /** The listbox element id, derived from the input id so both are unique per instance. */
  get listboxId(): string {
    return `${this.inputId}-listbox`;
  }

  /** The live-region id, referenced from the input's describedby chain. */
  get statusId(): string {
    return `${this.inputId}-status`;
  }

  /** The id of option `i` — what `aria-activedescendant` points at. */
  optionId(i: number): string {
    return `${this.inputId}-opt-${i}`;
  }

  /** `aria-activedescendant`: the active option's id, or null when nothing is active. */
  get activeDescendant(): string | null {
    const i = this.activeIndex();
    return this.open() && i >= 0 && i < this.options().length ? this.optionId(i) : null;
  }

  /**
   * The input's describedby chain: the caller's ids, plus our live region ONLY while it
   * actually says something. Referencing an empty node would make a screen reader read the
   * control's description as trailing silence — and the region still announces its own
   * changes via `aria-live` regardless of whether it is described-by.
   */
  get describedByChain(): string {
    return [this.describedBy, this.statusText ? this.statusId : '']
      .filter(Boolean).join(' ');
  }

  /**
   * The `role=status` text. Every state is named, because an empty list is otherwise
   * ambiguous — nothing found, or not enough typed yet?
   */
  get statusText(): string {
    const q = this.value.trim();
    if (!q) return '';
    if (q.length < TargetTypeaheadComponent.MIN_QUERY) {
      return `Keep typing — ${TargetTypeaheadComponent.MIN_QUERY} characters needed to search.`;
    }
    if (this.noMatches()) {
      return 'No match in your moderation queues. You can still type any target directly.';
    }
    const n = this.options().length;
    if (!n) return '';
    return `${n} suggestion${n === 1 ? '' : 's'} from your queues. Use the up and down arrow keys to review, Enter to choose.`;
  }

  /** Keystroke handler: publish the raw value immediately, then debounce the lookup. */
  onInput(raw: string): void {
    this.value = raw;
    this.valueChange.emit(raw);
    this.noMatches.set(false);
    this.activeIndex.set(-1);
    this.scheduleSearch(raw);
  }

  /** Keyboard contract — see the class doc. */
  onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.move(-1);
        break;
      case 'Enter': {
        const i = this.activeIndex();
        // Only swallow Enter when it is choosing something — otherwise it must still submit
        // the moderation form the picker sits in.
        if (this.open() && i >= 0 && i < this.options().length) {
          e.preventDefault();
          this.choose(this.options()[i]);
        }
        break;
      }
      case 'Escape':
        // Close only — never clear what the moderator typed.
        if (this.open()) {
          e.preventDefault();
          this.close();
        }
        break;
      default:
        break;
    }
  }

  /** Commit a suggestion into the field and hand focus back to the input. */
  choose(s: ModTargetSuggestion): void {
    this.value = s.target;
    this.valueChange.emit(s.target);
    // Drop the list, not just the popup: focus() below fires onFocus, which re-opens
    // whenever suggestions are still held — so closing alone would spring it back open.
    this.options.set([]);
    this.close();
    this.inputEl()?.nativeElement.focus();
  }

  /** Close on blur, but only after a click on an option has had a chance to land. */
  onBlur(): void {
    // mousedown on an option blurs the input BEFORE click fires; closing synchronously
    // would unmount the option and swallow the selection.
    setTimeout(() => this.close(), 150);
  }

  /** Re-open the popup when a previously-searched input regains focus. */
  onFocus(): void {
    if (this.options().length) this.open.set(true);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Move the active option by `delta`, wrapping, opening a closed popup first. */
  private move(delta: number): void {
    const n = this.options().length;
    if (!n) return;
    if (!this.open()) {
      this.open.set(true);
      this.activeIndex.set(delta > 0 ? 0 : n - 1);
      return;
    }
    this.activeIndex.set((this.activeIndex() + delta + n) % n);
  }

  /** Debounce a lookup for `raw`, cancelling whatever was pending. */
  private scheduleSearch(raw: string): void {
    this.cancelPending();
    const q = raw.trim();
    if (q.length < TargetTypeaheadComponent.MIN_QUERY) {
      this.options.set([]);
      this.open.set(false);
      return;
    }
    this.timer = setTimeout(() => this.runSearch(q), TargetTypeaheadComponent.DEBOUNCE_MS);
  }

  /** Run the (local, already domain-scoped) lookup and fold it into the popup state. */
  private runSearch(q: string): void {
    const rows = this.directory.search(q, TargetTypeaheadComponent.PAGE_SIZE);
    this.options.set(rows);
    this.noMatches.set(rows.length === 0);
    this.open.set(rows.length > 0);
    this.activeIndex.set(-1);
  }

  /** Close the popup and drop the active option (the typed value is untouched). */
  private close(): void {
    this.open.set(false);
    this.activeIndex.set(-1);
  }

  /** Cancel the pending debounce timer. */
  private cancelPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
