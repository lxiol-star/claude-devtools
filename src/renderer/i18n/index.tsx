/**
 * Lightweight i18n for the renderer.
 *
 * - No external dependency; a flat dictionary per locale with dot-namespaced keys
 *   (e.g. `settings.general.theme`, `common.cancel`).
 * - Locale modules live in `locales/<lang>/<area>.ts` and are merged by
 *   `locales/<lang>/index.ts`. Each feature area owns its pair of files.
 * - Missing keys fall back to English, then to the key itself.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { en } from './locales/en';
import { zh } from './locales/zh';

export type Language = 'en' | 'zh';

export const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '简体中文' },
];

const STORAGE_KEY = 'devtools-language';

const dictionaries: Record<Language, Record<string, string>> = { en, zh };

function detectSystemLanguage(): Language {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function loadLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to system detection
  }
  return detectSystemLanguage();
}

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

// Default context value renders English outside an I18nProvider (tests, static markup).
const defaultT = (key: string, vars?: Record<string, string | number>): string =>
  interpolate(dictionaries.en[key] ?? key, vars);

const I18nContext = createContext<I18nContextValue>({
  language: 'en',
  setLanguage: () => undefined,
  t: defaultT,
});

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}

export const I18nProvider = ({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element => {
  const [language, setLanguageState] = useState<Language>(loadLanguage);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore persistence failures
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const template = dictionaries[language][key] ?? dictionaries.en[key] ?? key;
      return interpolate(template, vars);
    },
    [language]
  );

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** Translate a dot-namespaced key, with optional `{placeholder}` interpolation. */
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}

/** Current language plus setter, for the settings language selector. */
export function useLanguage(): Pick<I18nContextValue, 'language' | 'setLanguage'> {
  const { language, setLanguage } = useI18n();
  return { language, setLanguage };
}
