import { describe, expect, test } from 'bun:test';

import { applyPlural, formatAgentStatus } from './agentStatus';
import type { I18nKey, I18nParams } from '@/lib/i18n';

const dictionary = new Map(Object.entries({
  'chat.agentStatus.read.count': 'читает {count, plural, one {# файл} few {# файла} many {# файлов} other {# файлов}}',
  'chat.agentStatus.command': 'выполняет команду',
  'chat.agentStatus.usingTool': 'использует {name}',
  'chat.statusRow.modelStatus': '{model} {status}',
}));
const t = (key: I18nKey, params?: I18nParams): string => {
  const template = dictionary.get(key) ?? key;
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match)) : template;
};

describe('applyPlural', () => {
  test('picks the locale\'s plural category and writes the number', () => {
    const template = '{count, plural, one {# файл} few {# файла} many {# файлов} other {# файлов}}';
    expect(applyPlural(template, 2, 'ru')).toBe('2 файла');
    expect(applyPlural(template, 5, 'ru')).toBe('5 файлов');
    expect(applyPlural(template, 21, 'ru')).toBe('21 файл');
  });

  test('an exact case wins, and other covers a missing category', () => {
    expect(applyPlural('{count, plural, =2 {both} other {# of them}}', 2, 'en')).toBe('both');
    expect(applyPlural('{count, plural, other {# files}}', 3, 'en')).toBe('3 files');
  });

  test('the number uses the locale\'s digits', () => {
    expect(applyPlural('{count, plural, other {#}}', 3, 'ar')).toBe(new Intl.NumberFormat('ar').format(3));
  });
});

describe('formatAgentStatus', () => {
  test('follows the model through the locale\'s template', () => {
    expect(formatAgentStatus(t, 'ru', { key: 'chat.agentStatus.command' }, 'Opus 5.5')).toBe('Opus 5.5 выполняет команду');
  });

  test('stands alone with a capital first letter without a model', () => {
    expect(formatAgentStatus(t, 'ru', { key: 'chat.agentStatus.command' }, null)).toBe('Выполняет команду');
    expect(formatAgentStatus(t, 'ru', { key: 'chat.agentStatus.read.count', count: 3 }, '  ')).toBe('Читает 3 файла');
  });

  test('names the tool it does not know', () => {
    expect(formatAgentStatus(t, 'ru', { key: 'chat.agentStatus.usingTool', name: 'jev route' })).toBe('Использует jev route');
    expect(formatAgentStatus(t, 'ru', { key: 'chat.agentStatus.usingTool', name: "cash$&tool $$ $' $`" })).toBe("Использует cash$&tool $$ $' $`");
  });
});
