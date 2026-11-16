export const DEFAULT_LANGUAGE = 'en';

const LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  nl: 'Dutch',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  ru: 'Russian',
  es: 'Spanish',
  'pt-BR': 'Brazilian Portuguese',
  ko: 'Korean',
  pl: 'Polish',
  ja: 'Japanese',
  tr: 'Turkish',
  ar: 'Arabic',
  he: 'Hebrew',
};

export function normalizeLanguage(value) {
  if (typeof value !== 'string' || !value) return DEFAULT_LANGUAGE;
  if (Object.hasOwn(LANGUAGE_NAMES, value)) return value;

  // Tolerate case and separator drift (`ru-RU`, `pt_br`) so a runtime that
  // passes a platform locale does not silently fall back to English.
  const normalized = value.toLowerCase().replace(/_/g, '-');
  const match = Object.keys(LANGUAGE_NAMES).find((tag) => {
    const lower = tag.toLowerCase();
    return lower === normalized || normalized.startsWith(`${lower}-`);
  });
  if (match) return match;

  const base = normalized.split('-')[0];
  const baseMatch = Object.keys(LANGUAGE_NAMES).find((tag) => tag.toLowerCase() === base);
  return baseMatch ?? DEFAULT_LANGUAGE;
}

export function languageName(language) {
  return LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES[DEFAULT_LANGUAGE];
}

export const __testing = { LANGUAGE_NAMES };
