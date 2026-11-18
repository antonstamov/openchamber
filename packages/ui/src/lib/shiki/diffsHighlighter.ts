import { canUseWASM, EXTENSION_TO_FILE_FORMAT, setCustomExtension, type HighlighterTypes } from '@pierre/diffs';

import { LANGUAGE_RELATIVES } from './languageRelatives';

export const DIFFS_HIGHLIGHTER: HighlighterTypes = canUseWASM() ? 'highlights' : 'shiki-js';

export const toDiffsLanguage = (lang: string | null): string | undefined => {
  if (!lang) return undefined;
  return DIFFS_HIGHLIGHTER === 'highlights' ? LANGUAGE_RELATIVES.get(lang) ?? lang : lang;
};

const FILE_NAME_LANGUAGES = {
  '.editorconfig': 'toml',
  '.gitmodules': 'toml',
  '.npmrc': 'toml',
};

// Extensions @pierre/diffs does not map to a language.
const EXTENSION_LANGUAGES = {
  sbt: 'scala',
};

// Diffs infer the language from the file name; the pool forwards these
// mappings to its workers.
if (DIFFS_HIGHLIGHTER === 'highlights') {
  for (const [extension, lang] of Object.entries(EXTENSION_TO_FILE_FORMAT)) {
    const alias = lang && LANGUAGE_RELATIVES.get(lang);
    if (alias) setCustomExtension(extension, alias);
  }
  for (const [name, lang] of Object.entries(FILE_NAME_LANGUAGES)) setCustomExtension(name, lang);
  for (const [extension, lang] of Object.entries(EXTENSION_LANGUAGES)) setCustomExtension(extension, lang);
}
