import React from 'react';

import { SettingsChipGroup, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';

export const DictationMicrophoneField: React.FC = () => {
    const { t } = useI18n();
    const dictationMicrophoneSource = useConfigStore((state) => state.dictationMicrophoneSource);
    const setDictationMicrophoneSource = useConfigStore((state) => state.setDictationMicrophoneSource);

    return (
        <SettingsFieldRow
            label={t('settings.voice.page.field.microphone')}
            info={t('settings.voice.page.field.microphoneInfo')}
            settingsItem="voice.microphone-source"
        >
            <SettingsChipGroup
                value={dictationMicrophoneSource}
                onChange={setDictationMicrophoneSource}
                aria-label={t('settings.voice.page.field.microphone')}
                options={[
                    { value: 'default', label: t('settings.voice.page.field.microphoneDefault') },
                    { value: 'built-in', label: t('settings.voice.page.field.microphoneBuiltIn') },
                ]}
            />
        </SettingsFieldRow>
    );
};
