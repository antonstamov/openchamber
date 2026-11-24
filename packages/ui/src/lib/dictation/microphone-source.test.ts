import { expect, test } from 'bun:test';

import {
    acquireDictationMicrophoneStream,
    buildDictationAudioConstraints,
    parseDictationMicrophoneSource,
    pickBuiltInAudioInputDeviceId,
} from './microphone-source';

const input = (deviceId: string, label: string) => ({ deviceId, kind: 'audioinput' as const, label });

test('parses only the known microphone sources', () => {
    expect(parseDictationMicrophoneSource('built-in')).toBe('built-in');
    expect(parseDictationMicrophoneSource('default')).toBe('default');
    expect(parseDictationMicrophoneSource('headset')).toBeUndefined();
    expect(parseDictationMicrophoneSource(undefined)).toBeUndefined();
});

test('picks the built-in microphone over the headset', () => {
    expect(pickBuiltInAudioInputDeviceId([
        input('bt', 'WH-1000XM4 Bluetooth Hands-Free'),
        input('builtin', 'Built-in Microphone'),
    ])).toBe('builtin');
});

test('picks the russian built-in label and skips cyrillic headset labels', () => {
    expect(pickBuiltInAudioInputDeviceId([
        input('bt', 'Гарнитура Bluetooth'),
        input('builtin', 'Встроенный микрофон'),
    ])).toBe('builtin');
});

test('accepts a built-in label even when it also names a headset link', () => {
    expect(pickBuiltInAudioInputDeviceId([
        input('bt', 'Bluetooth Headset'),
        input('combo', 'Built-in Microphone (Bluetooth SCO)'),
    ])).toBe('combo');
});

test('returns null when devices cannot be identified', () => {
    expect(pickBuiltInAudioInputDeviceId([])).toBeNull();
    expect(pickBuiltInAudioInputDeviceId([input('a', ''), input('b', '')])).toBeNull();
    expect(pickBuiltInAudioInputDeviceId([input('bt', 'Bluetooth Headset')])).toBeNull();
});

test('builds default constraints without a device id', () => {
    expect(buildDictationAudioConstraints()).toEqual({
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
    });
    expect(buildDictationAudioConstraints('mic-1').deviceId).toEqual({ exact: 'mic-1' });
});

const withMediaDevices = (devices: {
    enumerateDevices?: () => Promise<{ deviceId: string; kind: string; label: string }[]>;
    getUserMedia: (constraints: unknown) => Promise<string>;
}) => {
    const calls: unknown[] = [];
    const mediaDevices = {
        enumerateDevices: devices.enumerateDevices,
        getUserMedia: (constraints: unknown) => {
            calls.push(constraints);
            return devices.getUserMedia(constraints);
        },
    };
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    return calls;
};

test('records with the built-in device id when one is visible', async () => {
    const calls = withMediaDevices({
        enumerateDevices: async () => [
            { deviceId: 'bt', kind: 'audioinput', label: 'Bluetooth Headset' },
            { deviceId: 'builtin', kind: 'audioinput', label: 'Built-in Microphone' },
        ],
        getUserMedia: async () => 'stream',
    });

    await acquireDictationMicrophoneStream('built-in');

    expect(calls).toEqual([{ audio: buildDictationAudioConstraints('builtin') }]);
});

test('falls back to the system default when no device is visible', async () => {
    const calls = withMediaDevices({
        enumerateDevices: async () => [],
        getUserMedia: async () => 'stream',
    });

    await acquireDictationMicrophoneStream('built-in');

    expect(calls).toEqual([{ audio: buildDictationAudioConstraints() }]);
});

test('falls back to the system default without enumerateDevices', async () => {
    const calls = withMediaDevices({
        enumerateDevices: undefined,
        getUserMedia: async () => 'stream',
    });

    await acquireDictationMicrophoneStream('built-in');

    expect(calls).toEqual([{ audio: buildDictationAudioConstraints() }]);
});

test('retries with the system default when the exact device is gone', async () => {
    const calls = withMediaDevices({
        enumerateDevices: async () => [{ deviceId: 'gone', kind: 'audioinput', label: 'Built-in Microphone' }],
        getUserMedia: async (constraints) => {
            if (JSON.stringify(constraints).includes('gone')) {
                throw new DOMException('The requested device is gone', 'OverconstrainedError');
            }
            return 'stream';
        },
    });

    await acquireDictationMicrophoneStream('built-in');

    expect(calls).toEqual([
        { audio: buildDictationAudioConstraints('gone') },
        { audio: buildDictationAudioConstraints() },
    ]);
});

test('never enumerates for the default source', async () => {
    let enumerated = false;
    const calls = withMediaDevices({
        enumerateDevices: async () => {
            enumerated = true;
            return [];
        },
        getUserMedia: async () => 'stream',
    });

    await acquireDictationMicrophoneStream('default');

    expect(enumerated).toBe(false);
    expect(calls).toEqual([{ audio: buildDictationAudioConstraints() }]);
});
