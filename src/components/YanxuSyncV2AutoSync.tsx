import { useEffect } from 'react';
import { isTauri } from '../lib/ipc';
import { startYanxuSyncV2AutoSync } from '../lib/yanxu-sync-v2-auto';

export function YanxuSyncV2AutoSync() {
  useEffect(() => {
    if (!isTauri) return;
    return startYanxuSyncV2AutoSync();
  }, []);

  return null;
}
