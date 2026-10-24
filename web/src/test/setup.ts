import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no scrollIntoView. Current Chrome and Edge return a Promise from smooth
// scrolling, so the stand-in does too: code that leaks that Promise out of a React
// effect (which crashes the real page) then fails in tests as well.
Element.prototype.scrollIntoView = vi.fn(() => Promise.resolve()) as unknown as Element['scrollIntoView'];

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
