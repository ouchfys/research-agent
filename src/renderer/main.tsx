import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import 'katex/dist/katex.min.css';
import './styles.css';
import './shelf-directory.css';

class AppBoundary extends React.Component<React.PropsWithChildren, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="boot-error"><h1>界面暂时无法显示</h1><p>{this.state.error}</p><p>已保存的文档和研究任务仍保留在本地。</p><button className="primary" onClick={() => location.reload()}>重新打开界面</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<AppBoundary><App /></AppBoundary>);
