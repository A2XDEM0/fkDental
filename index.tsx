import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource-variable/noto-sans-sc/wght.css';
import './theme.css';
import './index.css';
import { clinicService } from './services/clinicService';
import { initializeTheme } from './utils/theme';

initializeTheme();

// 移除 RAG/AI 功能后，清理旧版本遗留的知识库、接口地址和 API Key 配置。
['ragKnowledgeEntries', 'ragAiSettings', 'ragExternalSources'].forEach(key => localStorage.removeItem(key));

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <div className="flex h-screen items-center justify-center bg-white text-slate-500">
    正在加载诊所数据...
  </div>
);

clinicService.initialize().finally(() => {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
