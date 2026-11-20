import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { ContentState, ContentLoadingState } from '@/components/ui/content-state';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getFileExtension } from '@/lib/toolHelpers';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';

export interface BinaryTextPreview {
  shown: boolean;
  content: string | null;
  loading: boolean;
  error: string | null;
  onShow: () => void;
  onHide: () => void;
}

export const BinaryArtifact: React.FC<{
  name: string;
  path: string;
  sizeBytes: number | null;
  download?: React.ReactNode;
  description?: string;
  textPreview?: BinaryTextPreview;
}> = ({ name, path, sizeBytes, download, description, textPreview }) => {
  const { t } = useI18n();
  const extension = getFileExtension(path).toUpperCase();
  if (textPreview?.shown) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ArtifactMetaBar items={[extension, formatArtifactSize(sizeBytes)]} />
        {textPreview.loading ? (
          <ContentLoadingState label={t('filesView.artifact.state.loading')} />
        ) : textPreview.error ? (
          <ContentState
            icon={<Icon name="error-warning" className="size-10 text-[color:var(--status-error)]" />}
            title={name}
            description={textPreview.error}
            actions={(
              <>
                {download}
                <Button type="button" variant="outline" size="sm" onClick={textPreview.onShow}>
                  <Icon name="refresh" className="me-2 size-4" />
                  {t('filesView.artifact.state.retry')}
                </Button>
              </>
            )}
          />
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <pre className="typography-code whitespace-pre-wrap break-words text-foreground">{textPreview.content ?? ''}</pre>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-edge-muted px-3 py-2">
              {download}
              <Button type="button" variant="outline" size="sm" onClick={textPreview.onHide}>
                <Icon name="eye-off" className="me-2 size-4" />
                {t('filesView.artifact.binary.hideAsText')}
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={[extension, formatArtifactSize(sizeBytes)]} />
      <ContentState
        icon={<FileTypeIcon filePath={path} className="size-10" />}
        title={name}
        description={description ?? (extension
          ? t('filesView.artifact.binary.descriptionWithType', { extension })
          : t('filesView.artifact.binary.description'))}
        actions={(
          <>
            {download}
            {textPreview ? (
              <Button type="button" variant="outline" size="sm" onClick={textPreview.onShow}>
                <Icon name="file-text" className="me-2 size-4" />
                {t('filesView.artifact.binary.showAsText')}
              </Button>
            ) : null}
          </>
        )}
      />
    </div>
  );
};
