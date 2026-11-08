// Content page for each sidebar tab in the settings dialog. Each tab is a vertical stack of section cards;
// the real logic lives in the *Section files — this only decides which sections belong to which tab.

import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { AndroidPermissionsPanel } from '@android/components/AndroidPermissionsPanel';
import { Tooltip } from '../../components/Tooltip';
import { detectOS } from '../../components/WindowChrome';
import { RecordingInputSection } from './RecordingInputSection';
import { ShortcutsSection } from './ShortcutsSection';
import { SelectionWorkspaceSection } from './SelectionWorkspaceSection';
import { LanguageSection } from './LanguageSection';
import { TypographySection } from './TypographySection';
import { ThemeSection } from './ThemeSection';
import { ProvidersSection } from './ChannelList';
import { OmniChannelSection } from './ProvidersSection';
import { NetworkSection } from './NetworkSection';
import { PermissionsSection } from './PermissionsSection';
import { DataStorageSection } from './DataStorageSection';
import { YanxuSyncV2Section } from './YanxuSyncV2Section';
import { LocalMigrationSection } from './LocalMigrationSection';
import { LocalModelsSection } from './models/LocalModelsSection';
import { LocalModelsNavContext } from './models/modelsNav';
import { getPlatformCapabilities, getCachedPlatformCapabilities } from '../../lib/platform';
import { listChannels } from '../../lib/ipc';
import type { PlatformCapabilities } from '../../lib/types';
import { type OS } from '../../components/WindowChrome';
import { useHotkeySettings } from '../../state/HotkeySettingsContext';
import { emitSaved } from '../../lib/savedEvent';
import { SettingRow, segmentedTrackStyle } from './shared';
import { Card } from '../_atoms';
import { usePageTransition, useSelectionMotion } from '../../lib/motion';
import {
  availableServiceViews,
  isServiceViewInactive,
  resolveServiceView,
  type ServiceViewId,
} from './navigation';

// Platform capability query shared by all tabs (drives desktop/mobile and hotkey / auto-update gating).
function usePlatformCaps(): PlatformCapabilities | null {
  const [platformCaps, setPlatformCaps] = useState(getCachedPlatformCapabilities);

  useEffect(() => {
    void getPlatformCapabilities().then(setPlatformCaps);
  }, []);

  return platformCaps;
}

// Recording & input: from recording to text insertion, plus phone input.
export function GeneralTab({ os }: { os?: OS } = {}) {
  return (
    <>
      <RecordingInputSection forcedOs={os} />
      <SelectionWorkspaceSection showShortcut={false} />
    </>
  );
}

export function InputMethodTab() {
  const { t } = useTranslation();
  return (
    <>
      <Card>
        <AndroidPermissionsPanel mode="overlayConfig" />
      </Card>
      <Card>
        <div style={{ display: 'grid', gap: 8 }}>
          <strong style={{ fontSize: 13, color: 'var(--ol-ink)' }}>
            {t('settings.inputMethod.guidanceTitle')}
          </strong>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--ol-ink-3)', lineHeight: 1.6 }}>
            {t('settings.inputMethod.enableSystemIme')}
          </p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--ol-ink-3)', lineHeight: 1.6 }}>
            {t('settings.inputMethod.longPressLogo')}
          </p>
        </div>
      </Card>
    </>
  );
}

export function ShortcutsTab() {
  const platformCaps = usePlatformCaps();
  if (!platformCaps?.supportsDesktopHotkey) return null;
  return <ShortcutsSection />;
}

export function AppearanceTab() {
  return (
    <>
      <ThemeSection />
      <TypographySection />
      <LanguageSection />
    </>
  );
}

// AI services & models: organizes channels, local models, and network settings by current pipeline and platform capabilities.
export function ServicesTab({ asrNavigation = 0 }: { asrNavigation?: number } = {}) {
  const { t } = useTranslation();
  const { prefs, updatePrefs } = useHotkeySettings();
  const platformCaps = usePlatformCaps();
  const showLocalModel = detectOS() !== 'mac' && platformCaps?.supportsLocalAsr === true;
  const multimodal =
    prefs?.multimodalPipelineEnabled === true && prefs.pipelineMode === 'multimodal';
  const [view, setView] = useState<ServiceViewId>(asrNavigation ? 'asr' : 'llm');
  useEffect(() => {
    if (asrNavigation) setView('asr');
  }, [asrNavigation]);
  const views = availableServiceViews(showLocalModel, detectOS());
  const requestedView = resolveServiceView(view, views, multimodal, detectOS());
  const contentRef = useRef<HTMLDivElement>(null);
  const selectedView = usePageTransition(requestedView, contentRef, false);
  const pipelineRef = useRef<HTMLDivElement>(null);
  const pipelineIndicatorRef = useRef<HTMLSpanElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const navigationIndicatorRef = useRef<HTMLSpanElement>(null);
  useSelectionMotion(pipelineRef, pipelineIndicatorRef, multimodal ? 'multimodal' : 'traditional');
  useSelectionMotion(
    navigationRef,
    navigationIndicatorRef,
    `${requestedView}:${views.length}`,
    true,
  );
  const setPipelineMode = (mode: 'traditional' | 'multimodal') => {
    if (!prefs || (multimodal ? 'multimodal' : 'traditional') === mode) return;
    void updatePrefs((current) => ({
      ...current,
      pipelineMode: mode,
      multimodalPipelineEnabled: true,
    })).catch((error) => {
      console.error('[settings] failed to update pipeline mode', error);
      emitSaved('failed', t('common.operationFailed'));
    });
  };

  // Language models / speech recognition are required config: the active tabs carry a status dot — red when
  // unconfigured, green when configured. After any channel add/remove/edit/toggle ChannelList broadcasts
  // ol-channels-changed and this recomputes immediately.
  const [requiredConfigured, setRequiredConfigured] = useState<{ llm: boolean; asr: boolean }>({
    llm: false,
    asr: false,
  });
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void Promise.all([listChannels('llm'), listChannels('asr')])
        .then(([llm, asr]) => {
          if (cancelled) return;
          setRequiredConfigured({
            llm: llm.some((channel) => channel.enabled),
            asr: asr.some((channel) => channel.enabled),
          });
        })
        .catch(() => {
          /* On read failure, keep the previous state and don't disturb the user */
        });
    };
    load();
    window.addEventListener('ol-channels-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('ol-channels-changed', load);
    };
  }, []);

  return (
    <>
      <div className="ol-services-page">
        <div className="ol-service-pipeline-mode">
          <SettingRow
            className="ol-service-pipeline-row"
            label={t('settings.providers.pipelineModeLabel')}
            desc={t('settings.providers.pipelineModeHint')}
          >
            <div
              ref={pipelineRef}
              className="ol-service-pipeline-track"
              role="group"
              aria-label={t('settings.providers.pipelineModeLabel')}
              style={segmentedTrackStyle}
            >
              <span
                ref={pipelineIndicatorRef}
                aria-hidden
                className="ol-service-pipeline-indicator"
              />
              {(['traditional', 'multimodal'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={!prefs}
                  aria-pressed={(multimodal ? 'multimodal' : 'traditional') === mode}
                  onClick={() => setPipelineMode(mode)}
                  className="ol-service-pipeline-option"
                >
                  {t(
                    `settings.providers.pipelineMode${mode === 'traditional' ? 'Traditional' : 'Multimodal'}`,
                  )}
                </button>
              ))}
            </div>
          </SettingRow>
          <p className="ol-service-pipeline-hint">
            {t('settings.providers.pipelineIsolationNotice')}
          </p>
        </div>
        <div
          ref={navigationRef}
          role="group"
          aria-label={t('modal.serviceViews.label')}
          className="ol-service-views"
          style={{ gridTemplateColumns: `repeat(${views.length}, minmax(0, 1fr))` }}
        >
          <span ref={navigationIndicatorRef} aria-hidden className="ol-service-view-indicator" />
          {views.map((id) => {
            if (id === 'models' && detectOS() === 'mac') {
              return (
                <Tooltip
                  key={id}
                  content={t('experimentalAsr.retiredHint')}
                  placement="bottom"
                  wrap
                  focusable
                  trigger={<span />}
                >
                  <button
                    type="button"
                    disabled
                    data-retired-local-models
                    aria-label={t('modal.serviceViews.models')}
                    style={{ pointerEvents: 'none' }}
                  >
                    <span>{t('modal.serviceViews.models')}</span>
                    <span className="ol-service-inactive-tag">
                      {t('experimentalAsr.retiredLabel')}
                    </span>
                  </button>
                </Tooltip>
              );
            }
            const inactive = isServiceViewInactive(id, multimodal, detectOS());
            const required = !inactive && (id === 'llm' || id === 'asr');
            const configured =
              id === 'llm' ? requiredConfigured.llm : id === 'asr' ? requiredConfigured.asr : false;
            const label = t(`modal.serviceViews.${id}`);
            const inactiveLabel = t('modal.serviceViews.inactive');
            return (
              <button
                key={id}
                type="button"
                disabled={inactive}
                aria-pressed={requestedView === id}
                onClick={() => setView(id)}
                aria-label={
                  inactive
                    ? `${label}。${inactiveLabel}`
                    : required
                      ? `${label}。${t(
                          configured
                            ? 'modal.serviceViews.statusConfigured'
                            : 'modal.serviceViews.statusMissing',
                        )}`
                      : label
                }
                title={
                  inactive
                    ? inactiveLabel
                    : required
                      ? t(
                          configured
                            ? 'modal.serviceViews.statusConfigured'
                            : 'modal.serviceViews.statusMissing',
                        )
                      : undefined
                }
              >
                <span className="ol-service-view-label">
                  {required && (
                    <span
                      aria-hidden
                      className="ol-service-status-dot"
                      data-state={configured ? 'ok' : 'missing'}
                    />
                  )}
                  <span>{label}</span>
                </span>
                {inactive && <span className="ol-service-inactive-tag">{inactiveLabel}</span>}
              </button>
            );
          })}
        </div>
        <div key={selectedView} ref={contentRef} className="ol-service-content">
          {/* The LocalModelPicker inside the channel editor jumps to this view through this context. */}
          <LocalModelsNavContext.Provider
            value={showLocalModel && !multimodal ? () => setView('models') : null}
          >
            {selectedView === 'llm' && <ProvidersSection kind="llm" />}
            {selectedView === 'asr' && <ProvidersSection kind="asr" />}
            {selectedView === 'omni' && <OmniChannelSection />}
            {showLocalModel && selectedView === 'models' && <LocalModelsSection />}
            {selectedView === 'connections' && (
              <NetworkSection />
            )}
          </LocalModelsNavContext.Provider>
          {(selectedView === 'llm' || selectedView === 'asr') && (
            <p className="ol-service-storage-note">
              {t('settings.providers.credentialStorageNotice')}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// Privacy: local-first explanation + permission management · data storage.
export function PrivacyTab() {
  const { t } = useTranslation();
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderRadius: 10,
          background: 'var(--ol-blue-soft)',
          marginBottom: 2,
        }}
      >
        <span
          style={{
            fontSize: 11,
            padding: '3px 8px',
            borderRadius: 999,
            background: 'var(--ol-surface)',
            color: 'var(--ol-blue)',
            fontWeight: 'var(--ol-font-weight-semibold)',
            flexShrink: 0,
          }}
        >
          {t('modal.about.localFirst')}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--ol-ink-3)', lineHeight: 1.55 }}>
          {t('modal.about.privacyDesc')}
        </span>
      </div>
      <PermissionsSection />
      <DataStorageSection />
      <LocalMigrationSection />
    </>
  );
}

// The account section opens the self-hosted sync server settings directly.
export function AdvancedTab() {
  return <YanxuSyncV2Section />;
}

