// ============================================================================
// 应用设置上下文 - 管理各种开关设置
// ============================================================================

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

/** 应用设置 */
interface AppSettings {
  /** 是否显示锚点导航 */
  showAnchorNav: boolean;
  /** 大目录分析深度 (2-5，默认 3) */
  hotspotDepth: number;
  /** 大目录大小阈值 MB (10-500，默认 50) */
  hotspotSizeThreshold: number;
  /** 深度扫描时是否忽略系统目录（默认 true，保持现有行为） */
  hotspotIgnoreSystemDirs: boolean;
}

interface SettingsContextValue {
  /** 当前设置 */
  settings: AppSettings;
  /** 更新设置 */
  updateSettings: (updates: Partial<AppSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const STORAGE_KEY = 'c-cleanup-settings';

/** 默认设置 */
const defaultSettings: AppSettings = {
  showAnchorNav: true, // 默认打开
  hotspotDepth: 3,     // 默认分析深度 3 层
  hotspotSizeThreshold: 50, // 默认 50MB
  hotspotIgnoreSystemDirs: true, // 默认忽略系统目录
};

interface SettingsProviderProps {
  children: ReactNode;
}

export function SettingsProvider({ children }: SettingsProviderProps) {
  // 从 localStorage 读取保存的设置
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          return { ...defaultSettings, ...JSON.parse(saved) };
        }
      } catch (e) {
        console.error('读取设置失败:', e);
      }
    }
    return defaultSettings;
  });

  // 更新设置
  const updateSettings = useCallback((updates: Partial<AppSettings>) => {
    setSettings(prev => {
      const newSettings = { ...prev, ...updates };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
      return newSettings;
    });
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings 必须在 SettingsProvider 内部使用');
  }
  return context;
}
