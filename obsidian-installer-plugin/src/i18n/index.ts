import { en } from './locales/en';
import { zhTW } from './locales/zh-TW';

export type Locale = 'en' | 'zh-TW';
export type TranslationKey = keyof typeof en;

const dictionaries: Record<Locale, Record<string, string>> = {
  en,
  'zh-TW': zhTW,
};

let currentLocale: Locale = 'en';

export function detectLocale(raw: string | null): Locale {
  if (raw === 'zh' || raw === 'zh-TW' || raw === 'zh-CN' || raw === 'zh-HK') {
    return 'zh-TW';
  }
  return 'en';
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[currentLocale][key] ?? dictionaries.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}
