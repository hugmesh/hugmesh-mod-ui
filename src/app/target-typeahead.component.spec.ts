import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { TargetTypeaheadComponent } from './target-typeahead.component';
import { ModDirectoryService, ModTargetSuggestion } from './mod-directory.service';

/**
 * TargetTypeaheadComponent — the moderation console's target picker. The things a
 * hand-rolled combobox is easiest to get wrong: the ARIA wiring (no component library in
 * this repo to inherit it from), the keyboard contract, and the debounce.
 */
describe('TargetTypeaheadComponent', () => {
  let fixture: ComponentFixture<TargetTypeaheadComponent>;
  let component: TargetTypeaheadComponent;
  let directory: jasmine.SpyObj<ModDirectoryService>;

  const carol: ModTargetSuggestion = { target: '@carol:brandx.example', source: 'system finding' };
  const dave: ModTargetSuggestion = { target: '@dave:brandx.example', source: 'audit trail' };

  beforeEach(async () => {
    directory = jasmine.createSpyObj<ModDirectoryService>('ModDirectoryService', ['search']);
    directory.search.and.returnValue([carol, dave]);

    await TestBed.configureTestingModule({
      imports: [TargetTypeaheadComponent],
      providers: [{ provide: ModDirectoryService, useValue: directory }],
    }).compileComponents();

    fixture = TestBed.createComponent(TargetTypeaheadComponent);
    component = fixture.componentInstance;
    component.inputId = 'tt-target';
    component.testId = 'tt-target';
    fixture.detectChanges();
  });

  function el(): HTMLElement { return fixture.nativeElement; }
  function input(): HTMLInputElement { return el().querySelector('#tt-target')!; }

  /** Type `text` and let the debounce settle. */
  function type(text: string): void {
    const i = input();
    i.value = text;
    i.dispatchEvent(new Event('input'));
    tick(TargetTypeaheadComponent.DEBOUNCE_MS);
    fixture.detectChanges();
  }

  /** Dispatch a keydown on the input and settle. */
  function key(k: string): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    input().dispatchEvent(e);
    fixture.detectChanges();
    return e;
  }

  describe('ARIA (APG combobox with listbox popup)', () => {
    it('marks the input as a combobox controlling its listbox', () => {
      expect(input().getAttribute('role')).toBe('combobox');
      expect(input().getAttribute('aria-controls')).toBe('tt-target-listbox');
      expect(input().getAttribute('aria-autocomplete')).toBe('list');
      expect(el().querySelector('#tt-target-listbox')!.getAttribute('role')).toBe('listbox');
    });

    it('starts collapsed with no active descendant', () => {
      expect(input().getAttribute('aria-expanded')).toBe('false');
      expect(input().hasAttribute('aria-activedescendant')).toBeFalse();
    });

    it('expands and points aria-activedescendant at the highlighted option', fakeAsync(() => {
      type('car');
      expect(input().getAttribute('aria-expanded')).toBe('true');
      key('ArrowDown');
      expect(input().getAttribute('aria-activedescendant')).toBe('tt-target-opt-0');
      const opt = el().querySelector('#tt-target-opt-0')!;
      expect(opt.getAttribute('role')).toBe('option');
      expect(opt.getAttribute('aria-selected')).toBe('true');
    }));

    it('keeps DOM focus on the input while arrowing', fakeAsync(() => {
      document.body.appendChild(fixture.nativeElement);
      input().focus();
      type('car');
      key('ArrowDown');
      expect(document.activeElement).toBe(input());
      fixture.nativeElement.remove();
    }));

    it('omits its own live region from describedby while it is empty', () => {
      fixture.componentRef.setInput('describedBy', 'mc-ban-target-help');
      fixture.detectChanges();
      expect(input().getAttribute('aria-describedby')).toBe('mc-ban-target-help');
    });

    it('appends its live region once it says something', fakeAsync(() => {
      fixture.componentRef.setInput('describedBy', 'mc-ban-target-help');
      type('car');
      expect(input().getAttribute('aria-describedby'))
        .toBe('mc-ban-target-help tt-target-status');
    }));

    it('names the source of each suggestion', fakeAsync(() => {
      type('car');
      expect(el().querySelector('#tt-target-opt-0')!.textContent).toContain('system finding');
    }));
  });

  describe('keyboard', () => {
    it('ArrowDown/ArrowUp move the active option and wrap', fakeAsync(() => {
      type('a');
      type('ar');
      key('ArrowDown');
      expect(component.activeIndex()).toBe(0);
      key('ArrowDown');
      expect(component.activeIndex()).toBe(1);
      key('ArrowDown');
      expect(component.activeIndex()).withContext('wraps to the top').toBe(0);
      key('ArrowUp');
      expect(component.activeIndex()).withContext('wraps to the bottom').toBe(1);
    }));

    it('Enter commits the active option and keeps the popup shut', fakeAsync(() => {
      const emitted: string[] = [];
      component.valueChange.subscribe(v => emitted.push(v));
      type('car');
      key('ArrowDown');
      const e = key('Enter');
      expect(e.defaultPrevented).withContext('must not submit the form').toBeTrue();
      expect(component.value).toBe('@carol:brandx.example');
      expect(emitted.at(-1)).toBe('@carol:brandx.example');
      expect(component.open()).toBeFalse();
      expect(component.options()).toEqual([]);
    }));

    it('Enter with nothing highlighted still submits the surrounding form', fakeAsync(() => {
      type('car');
      const e = key('Enter');
      expect(e.defaultPrevented).toBeFalse();
    }));

    it('Escape closes the popup WITHOUT clearing what was typed', fakeAsync(() => {
      type('car');
      expect(component.open()).toBeTrue();
      key('Escape');
      expect(component.open()).toBeFalse();
      expect(component.value).toBe('car');
    }));
  });

  describe('search behaviour', () => {
    it('does not look up below the minimum query length', fakeAsync(() => {
      type('c');
      expect(directory.search).not.toHaveBeenCalled();
      expect(component.statusText).toContain('Keep typing');
    }));

    it('looks up ONCE for a burst of keystrokes within the debounce window', fakeAsync(() => {
      const i = input();
      for (const v of ['ca', 'car', 'caro', 'carol']) {
        i.value = v;
        i.dispatchEvent(new Event('input'));
        tick(TargetTypeaheadComponent.DEBOUNCE_MS / 5);
      }
      tick(TargetTypeaheadComponent.DEBOUNCE_MS);
      expect(directory.search).toHaveBeenCalledTimes(1);
      expect(directory.search).toHaveBeenCalledWith('carol', TargetTypeaheadComponent.PAGE_SIZE);
    }));

    it('announces a no-matches state and keeps the free-text fallback', fakeAsync(() => {
      directory.search.and.returnValue([]);
      type('@stranger:elsewhere.example');
      expect(component.open()).toBeFalse();
      expect(component.statusText).toContain('No match in your moderation queues');
      expect(component.statusText).toContain('type any target directly');
      expect(component.value).toBe('@stranger:elsewhere.example');
    }));

    it('announces the suggestion count for a screen reader', fakeAsync(() => {
      type('car');
      expect(component.statusText).toContain('2 suggestions');
      const status = el().querySelector('[data-testid="tt-target-status"]')!;
      expect(status.getAttribute('role')).toBe('status');
      expect(status.getAttribute('aria-live')).toBe('polite');
    }));
  });
});
