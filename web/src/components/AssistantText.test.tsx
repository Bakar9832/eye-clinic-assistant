import { render } from '@testing-library/react';
import { AssistantText } from './AssistantText';

const show = (text: string) => render(<AssistantText text={text} />).container;

describe('assistant replies: light markdown, rendered safely', () => {
  it('M1. **Tuesday** is bold, *soon* is italic, and no asterisks show', () => {
    const view = show('Dr Ayesha is free on **Tuesday 10:00**, *soon*.');
    expect(view.querySelector('strong')?.textContent).toBe('Tuesday 10:00');
    expect(view.querySelector('em')?.textContent).toBe('soon');
    expect(view.textContent).not.toContain('*');
  });

  it('M2. bullet and numbered lists become list items; a single line break is kept', () => {
    const view = show('Free times:\n\n- 9:30 AM\n- 10:15 AM\n\n1. Pick a time\n2. Confirm\n\nLine one\nLine two');
    expect([...view.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['9:30 AM', '10:15 AM']);
    expect([...view.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['Pick a time', 'Confirm']);
    expect(view.querySelector('br')).not.toBeNull();
  });

  it('M3. links open in a new tab without access to this page', () => {
    const link = show('See [our hours](https://example.com/hours).').querySelector('a')!;
    expect(link).toHaveAttribute('href', 'https://example.com/hours');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('M4. raw HTML is never rendered: <script> and inline tags are dropped', () => {
    const view = show('Hello <script>alert(1)</script> and <b onclick="x()">bold</b> <img src=x onerror="alert(1)">');
    expect(view.querySelector('script, img, b, [onclick], [onerror]')).toBeNull();
    expect(view.innerHTML).not.toMatch(/<script|onclick|onerror/);
    // The tags are gone; any words between them are left as inert text.
    expect(view.textContent).toBe('Hello alert(1) and bold ');
  });

  it('M5. javascript: and data: links are shown as plain text, not links', () => {
    const view = show('[x](javascript:alert(1)) and [y](data:text/html,<script>alert(1)</script>)');
    expect(view.querySelector('a')).toBeNull();
    expect(view.innerHTML).not.toMatch(/javascript:|data:/);
    expect(view.textContent).toContain('x');
  });

  it('M6. headings, tables and images are not drawn as such (plain text instead)', () => {
    const view = show('# Big title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![pic](https://example.com/p.png)');
    expect(view.querySelector('h1, table, img')).toBeNull();
    expect(view.textContent).toContain('Big title');
  });
});
