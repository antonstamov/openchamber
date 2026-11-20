export interface MobileDictationMountFlags {
    isMobile: boolean;
    isBtwActive: boolean;
    mobileCommentActive: boolean;
    messageSelectionActive: boolean;
}

export function shouldMountMobileDictationEngine(flags: MobileDictationMountFlags): boolean {
    void flags.isBtwActive;
    return flags.isMobile && !flags.mobileCommentActive && !flags.messageSelectionActive;
}
