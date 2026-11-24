export type DictationMicrophoneSource = 'default' | 'built-in';

export const DICTATION_MICROPHONE_SOURCE_STORAGE_KEY = 'dictationMicrophoneSource';

export const DEFAULT_DICTATION_MICROPHONE_SOURCE: DictationMicrophoneSource = 'default';

export const parseDictationMicrophoneSource = (value: unknown): DictationMicrophoneSource | undefined => {
    if (value === 'built-in') return 'built-in';
    if (value === 'default') return 'default';
    return undefined;
};

type AudioInputDescriptor = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>;

const BUILT_IN_LABEL_PATTERN = /built[\s_-]?in|internal|встроен|macbook|imac|iphone|ipad/i;
const HEADSET_LABEL_PATTERN = /bluetooth|headset|hands[\s_-]?free|airpods|\bbuds\b|headphones?|гарнитура|наушник|\bSCO\b/i;

export const pickBuiltInAudioInputDeviceId = (devices: readonly AudioInputDescriptor[]): string | null => {
    const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
    if (inputs.length === 0) return null;
    const identifiable = inputs.filter((device) => device.label.trim().length > 0);
    if (identifiable.length === 0) return null;
    const withoutHeadset = identifiable.filter((device) => !HEADSET_LABEL_PATTERN.test(device.label));
    const builtIn = withoutHeadset.find((device) => BUILT_IN_LABEL_PATTERN.test(device.label))
        ?? identifiable.find((device) => BUILT_IN_LABEL_PATTERN.test(device.label));
    return builtIn?.deviceId ?? null;
};

const BASE_AUDIO_CONSTRAINTS = {
    channelCount: 1,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
} as const;

export const buildDictationAudioConstraints = (deviceId?: string | null): MediaTrackConstraints => (
    deviceId ? { ...BASE_AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } } : { ...BASE_AUDIO_CONSTRAINTS }
);

const getMediaDevices = (): MediaDevices | null => {
    try {
        return globalThis.navigator?.mediaDevices ?? null;
    } catch {
        return null;
    }
};

export const resolveDictationMicrophoneDeviceId = async (
    preference: DictationMicrophoneSource,
): Promise<string | null> => {
    if (preference !== 'built-in') return null;
    const mediaDevices = getMediaDevices();
    if (!mediaDevices) return null;
    let devices: MediaDeviceInfo[];
    try {
        devices = await mediaDevices.enumerateDevices();
    } catch {
        return null;
    }
    return pickBuiltInAudioInputDeviceId(devices);
};

const isMissingDeviceError = (error: unknown): boolean => (
    error instanceof DOMException
    && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')
);

const requestDefaultMicrophone = (mediaDevices: MediaDevices): Promise<MediaStream> => (
    mediaDevices.getUserMedia({ audio: buildDictationAudioConstraints() })
);

export const acquireDictationMicrophoneStream = async (
    preference: DictationMicrophoneSource,
): Promise<MediaStream> => {
    const mediaDevices = getMediaDevices();
    if (!mediaDevices || !mediaDevices.getUserMedia) {
        throw new Error('Microphone capture is not supported in this environment');
    }
    if (preference !== 'built-in') {
        return requestDefaultMicrophone(mediaDevices);
    }
    const deviceId = await resolveDictationMicrophoneDeviceId(preference);
    if (!deviceId) {
        return requestDefaultMicrophone(mediaDevices);
    }
    try {
        return await mediaDevices.getUserMedia({ audio: buildDictationAudioConstraints(deviceId) });
    } catch (error) {
        if (isMissingDeviceError(error)) {
            return requestDefaultMicrophone(mediaDevices);
        }
        throw error;
    }
};
