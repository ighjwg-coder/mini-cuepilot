import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { APP_NAME, APP_NAME_KO, APP_VERSION } from '@shared/version';

export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <h1>
        📹 {APP_NAME} <span style={{ fontWeight: 500 }}>{APP_NAME_KO}</span>{' '}
        <small className="muted mono" style={{ fontWeight: 400, fontSize: 11 }}>v{APP_VERSION}</small>
      </h1>
      <nav>
        <NavLink to="/" end>
          홈
        </NavLink>
        <NavLink to="/director">디렉터</NavLink>
        <NavLink to="/editor">에디터</NavLink>
      </nav>
      <div className="spacer" />
      {children}
    </header>
  );
}
