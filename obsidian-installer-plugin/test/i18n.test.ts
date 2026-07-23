import { describe, it, expect, beforeEach } from 'vitest';
import { detectLocale, setLocale, t } from '../src/i18n';
import { en } from '../src/i18n/locales/en';
import { zhTW } from '../src/i18n/locales/zh-TW';

describe('detectLocale', () => {
  it('maps zh variants to zh-TW', () => {
    expect(detectLocale('zh')).toBe('zh-TW');
    expect(detectLocale('zh-TW')).toBe('zh-TW');
    expect(detectLocale('zh-CN')).toBe('zh-TW');
    expect(detectLocale('zh-HK')).toBe('zh-TW');
  });

  it('falls back to en for anything else', () => {
    expect(detectLocale('en')).toBe('en');
    expect(detectLocale('ja')).toBe('en');
    expect(detectLocale(null)).toBe('en');
  });
});

describe('t', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('returns the plain string for a key with no vars', () => {
    expect(t('registry.heading')).toBe('Available in mirror');
  });

  it('interpolates vars', () => {
    expect(t('notice.removed', { id: 'my-plugin' })).toBe('Removed my-plugin');
  });

  it('switches dictionaries when locale changes', () => {
    setLocale('zh-TW');
    expect(t('registry.heading')).toBe('鏡像上可用的外掛');
  });

  it('falls back to English if a key is missing from the current locale', () => {
    setLocale('zh-TW');
    // @ts-expect-error deliberately unknown key to exercise the fallback path
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });
});

describe('locale parity', () => {
  it('en and zh-TW have identical key sets', () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
  });
});
